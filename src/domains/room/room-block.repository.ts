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
import { metrics } from "@src/infrastructure/metrics.js";

/**
 * The literal wire contract with Laravel's block fanout. MSAB owns both the
 * write (event-router on `room.member_removed`) and the read (`room:join`
 * GATE) of this key, in its own Redis — Laravel never touches it.
 *
 * NOTE: Laravel's `RoomUserBlock` cache key template is the same string, but
 * it lives in Laravel's own prefixed cache keyspace and is a completely
 * separate concern. The collision is cosmetic and has already caused one
 * misdiagnosis (msab-join-gates 02) — do not "align" the two.
 */
export const BLOCK_KEY = (roomId: string, userId: number) =>
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
   *
   * REJECTS on Redis failure. It must: a swallowed error here leaves a blocked
   * user able to rejoin over the socket with no signal anywhere, and the
   * caller (event-router) already routes the rejection to `reactError` →
   * Sentry. This method used to catch internally and resolve, which made that
   * escalation unreachable dead code (msab-join-gates 02).
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
      metrics.roomBlockMirror.inc({ operation: "write", result: "success" });
      this.logger.debug(
        { roomId, userId, remainingSeconds },
        "Room block mirror written",
      );
    } catch (err) {
      metrics.roomBlockMirror.inc({ operation: "write", result: "failure" });
      throw err;
    }
  }

  /**
   * Mirror an unblock — deletes the key regardless of remaining TTL.
   *
   * REJECTS on Redis failure, for the mirror-image reason: a swallowed error
   * leaves an unblocked user locked out of the socket join until the key's TTL
   * lapses — and a permanent block carries no TTL, so never.
   */
  async deleteBlock(roomId: string, userId: number): Promise<void> {
    const key = BLOCK_KEY(roomId, userId);
    try {
      await this.redis.del(key);
      metrics.roomBlockMirror.inc({ operation: "delete", result: "success" });
      this.logger.debug({ roomId, userId }, "Room block mirror deleted");
    } catch (err) {
      metrics.roomBlockMirror.inc({ operation: "delete", result: "failure" });
      throw err;
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
      // Deliberate fail-open — see the doc block above. Failing closed would
      // lock every legitimate joiner out of every room during a Redis blip,
      // which is a far larger outage than the moderation gap it prevents.
      // But fail-open MUST be loud: without this counter a broken mirror is
      // indistinguishable from a healthy one, which is precisely how
      // msab-join-gates 02 went unnoticed. Only failures are counted — the
      // success path is nearly every join and needs no metric.
      //
      // Both the counter and the log are themselves guarded: anything that
      // throws on the way out of a fail-OPEN path would silently convert it
      // into fail-CLOSED and start refusing legitimate joins. Observability
      // must never be able to take the gate down.
      try {
        metrics.roomBlockMirror.inc({ operation: "read", result: "failure" });
        this.logger.warn(
          { err, roomId, userId },
          "Room block mirror read failed — failing open (not blocked)",
        );
      } catch {
        // Intentionally empty — see above.
      }
      return { blocked: false, permanent: false, remainingSeconds: null };
    }
  }
}
