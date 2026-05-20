/**
 * Seat-grace service (F-6, F-37).
 *
 * Replaces the old in-process `Map<key, Timeout>` seat-grace timer. That timer
 * could neither be cancelled by a reconnect on a DIFFERENT instance (sticky
 * miss / PWA resume), nor survive the owning instance dying — both stranded a
 * seat — and even when it fired it emitted through the now-disconnected
 * socket's `.local` channel, so a user who reconnected elsewhere never saw
 * `seat:cleared`.
 *
 * Design: a Redis ZSET of pending clears (`member = "{roomId}:{userId}"`,
 * `score = fireAtMs`). Any instance can `cancel()` (ZREM) — cross-instance
 * correct. A periodic sweeper on every instance atomically claims due members
 * (Lua ZRANGEBYSCORE + ZREM, so exactly one instance processes each), runs the
 * authoritative `leaveSeat`, and broadcasts `seat:cleared` via the namespace
 * ADAPTER (not a stale socket) so the reconnected user on any instance gets
 * it, plus a cascade relay for cross-region parity.
 */
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { SeatRepository } from "./seat.repository.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import { logger } from "@src/infrastructure/logger.js";

const PENDING_ZSET = "seat-grace:pending";

/** Grace window before a disconnected speaker's seat is cleared. */
export const SEAT_CLEAR_GRACE_MS = 15_000;

const SWEEP_INTERVAL_MS = 5_000;
const SWEEP_BATCH = 100;

/**
 * Atomically claim due members: read those with score <= now, then ZREM them
 * in the same script so a concurrent sweeper on another instance can't also
 * claim them. Returns the claimed members.
 */
const CLAIM_DUE_LUA = `
  local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  if #due > 0 then
    redis.call('ZREM', KEYS[1], unpack(due))
  end
  return due
`;

interface RedisWithSeatGrace {
  seatGraceClaimDue(
    keyCount: 1,
    key: string,
    now: string,
    batch: string,
  ): Promise<string[]>;
}

export class SeatGraceService {
  private timer: NodeJS.Timeout | null = null;
  /** cascadeRelay is wired after bootstrap — null until then. */
  private cascadeRelay: CascadeRelay | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly seatRepository: SeatRepository,
    private readonly io: Server,
  ) {
    redis.defineCommand("seatGraceClaimDue", {
      numberOfKeys: 1,
      lua: CLAIM_DUE_LUA,
    });
  }

  /** Wire the cascade relay after server.ts bootstrap completes. */
  setCascadeRelay(relay: CascadeRelay | null): void {
    this.cascadeRelay = relay;
  }

  private member(roomId: string, userId: string): string {
    return `${roomId}:${userId}`;
  }

  /** Schedule a deferred seat clear (idempotent — ZADD overwrites the score). */
  async schedule(roomId: string, userId: string): Promise<void> {
    const fireAt = Date.now() + SEAT_CLEAR_GRACE_MS;
    try {
      await this.redis.zadd(
        PENDING_ZSET,
        String(fireAt),
        this.member(roomId, userId),
      );
    } catch (err) {
      logger.error({ err, roomId, userId }, "SeatGrace: schedule failed");
    }
  }

  /**
   * Cancel a pending clear (speaker reconnected in time) — works from ANY
   * instance. Returns true if a pending entry was removed.
   */
  async cancel(roomId: string, userId: string): Promise<boolean> {
    try {
      const removed = await this.redis.zrem(
        PENDING_ZSET,
        this.member(roomId, userId),
      );
      return removed > 0;
    } catch (err) {
      logger.error({ err, roomId, userId }, "SeatGrace: cancel failed");
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "Seat-grace sweeper started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Visible for tests: process one sweep tick. */
  async sweep(): Promise<void> {
    let due: string[];
    try {
      due = await (
        this.redis as unknown as RedisWithSeatGrace
      ).seatGraceClaimDue(1, PENDING_ZSET, String(Date.now()), String(SWEEP_BATCH));
    } catch (err) {
      logger.error({ err }, "SeatGrace: sweep claim failed");
      return;
    }
    if (!due || due.length === 0) return;

    for (const m of due) {
      // roomId may be a UUID (hyphens, no colons); userId is numeric — split
      // on the LAST colon so a colon in roomId can't corrupt the parse.
      const sep = m.lastIndexOf(":");
      if (sep <= 0) continue;
      await this.fireClear(m.slice(0, sep), m.slice(sep + 1));
    }
  }

  private async fireClear(roomId: string, userId: string): Promise<void> {
    try {
      const result = await this.seatRepository.leaveSeat(roomId, userId);
      if (result.success && result.seatIndex !== undefined) {
        const payload = {
          seatIndex: result.seatIndex,
          userId: Number(userId),
        };
        // F-37: namespace adapter fan-out (NOT a stale socket `.local`) so a
        // user who reconnected on any instance receives this.
        this.io.to(roomId).emit("seat:cleared", payload);

        if (this.cascadeRelay?.hasRemotes(roomId)) {
          this.cascadeRelay
            .relayToRemote(roomId, "seat:cleared", payload)
            .catch((err) =>
              logger.warn(
                { err, roomId, userId },
                "SeatGrace: cross-region relay failed",
              ),
            );
        }

        logger.debug(
          { roomId, userId, seatIndex: result.seatIndex },
          "Deferred seat clear fired",
        );
      }
    } catch (err) {
      logger.warn(
        { err, roomId, userId },
        "SeatGrace: deferred leaveSeat failed",
      );
    }
  }
}
