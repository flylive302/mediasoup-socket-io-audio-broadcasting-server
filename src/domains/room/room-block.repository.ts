/**
 * Room Block Repository — Redis mirror of the Laravel `RoomUserBlock` gate.
 *
 * ADR 0017: Laravel's DB is the durable source of truth; this key is a
 * derived mirror written by the block/unblock fanout ingest (event-router)
 * and read once, cheaply, by the `room:join` GATE to close the direct-socket
 * bypass. Safe to lose on fleet rebuild — the mirror repopulates on the next
 * block, and the Laravel HTTP gate remains authoritative regardless.
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";

const BLOCK_KEY = (roomId: string, userId: number) =>
  `room:${roomId}:blocked:${userId}`;

export class RoomBlockRepository {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  /**
   * Mirror a block. `remainingSeconds` null/undefined means permanent — no
   * TTL, the key lives until an explicit unblock deletes it. A timed block
   * gets `EX remainingSeconds` so it self-expires with no cleanup action.
   */
  async writeBlock(
    roomId: string,
    userId: number,
    remainingSeconds: number | null | undefined,
  ): Promise<void> {
    const key = BLOCK_KEY(roomId, userId);
    try {
      if (remainingSeconds === null || remainingSeconds === undefined) {
        await this.redis.set(key, "1");
      } else {
        const ttl = Math.max(1, Math.floor(remainingSeconds));
        await this.redis.set(key, "1", "EX", ttl);
      }
      this.logger.debug(
        { roomId, userId, remainingSeconds },
        "Room block mirror written",
      );
    } catch (err) {
      this.logger.warn(
        { err, roomId, userId },
        "Failed to write room block mirror — join GATE degrades to unblocked until next block/unblock",
      );
    }
  }

  /** Mirror an unblock — deletes the key regardless of remaining TTL. */
  async deleteBlock(roomId: string, userId: number): Promise<void> {
    const key = BLOCK_KEY(roomId, userId);
    try {
      await this.redis.del(key);
      this.logger.debug({ roomId, userId }, "Room block mirror deleted");
    } catch (err) {
      this.logger.warn(
        { err, roomId, userId },
        "Failed to delete room block mirror",
      );
    }
  }

  /**
   * GATE read — single `TTL` call, pure w.r.t. the caller (no side effects
   * beyond the Redis round trip). `TTL` discriminates all three states in
   * one read: -2 = key absent (not blocked), -1 = key exists with no expiry
   * (permanent block), >0 = blocked with that many seconds remaining — so
   * the join GATE gets existence AND remaining-time feedback for the same
   * single-read budget an `EXISTS` check would have cost. A Redis failure
   * fails OPEN (not blocked) so a mirror outage never locks legitimate
   * joiners out; Laravel's HTTP gate remains the authoritative check.
   */
  async getStatus(
    roomId: string,
    userId: number,
  ): Promise<{ blocked: boolean; permanent: boolean; remainingSeconds: number | null }> {
    try {
      const ttl = await this.redis.ttl(BLOCK_KEY(roomId, userId));
      if (ttl === -2) {
        return { blocked: false, permanent: false, remainingSeconds: null };
      }
      if (ttl === -1) {
        return { blocked: true, permanent: true, remainingSeconds: null };
      }
      return { blocked: true, permanent: false, remainingSeconds: ttl };
    } catch (err) {
      this.logger.warn(
        { err, roomId, userId },
        "Room block mirror read failed — failing open (not blocked)",
      );
      return { blocked: false, permanent: false, remainingSeconds: null };
    }
  }
}
