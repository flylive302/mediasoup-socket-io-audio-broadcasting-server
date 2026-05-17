/**
 * Room Registry — Redis-backed origin ownership tracker
 *
 * Tracks which instance is the origin for each room (CAS ownership) so
 * single-instance-per-room routing is safe across restarts.
 *
 * F-32: the cross-edge load-balancing surface (registerEdge /
 * updateListenerCount / getTotalListeners / findBestInstance) was dead code —
 * never called by any live path, writing garbage `listenerCount` data. It has
 * been removed. Cascade multi-edge routing is a deferred, scale-gated project;
 * if revived, the LB layer must be rebuilt from scratch — see CASCADE.md.
 *
 * Redis key schema:
 *   cascade:room:{roomId}:owner   → string instanceId (short-TTL CAS claim)
 *   cascade:room:{roomId}:origin  → JSON string { instanceId, ip, port, listenerCount }
 *   cascade:room:{roomId}:edges   → Hash { [instanceId]: JSON } (edge-dereg only)
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";

export interface InstanceInfo {
  instanceId: string;
  ip: string;
  port: number;
  listenerCount: number;
}

const KEY_PREFIX = "cascade:room:";
const TTL_SECONDS = 86_400; // 24 hours — origin info key (matches RoomStateRepository)

/**
 * F-34: the ownership CAS key uses a SHORT TTL refreshed by a heartbeat. A 24h
 * TTL meant an origin SIGKILL/OOM made every room it hosted un-claimable for
 * 24 hours. With a 90s TTL + ~30s heartbeat (RoomManager.startOwnershipHeartbeat),
 * a crashed origin's rooms self-recover within ~90s.
 */
const OWNER_TTL_SECONDS = 90;

export interface ClaimResult {
  /** True if this instance won the claim and should become origin. */
  won: boolean;
  /** The instanceId currently holding ownership (self if won, otherwise existing owner). */
  owner: string;
}

export class RoomRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  // ─── Origin Ownership (CAS) ────────────────────────────────────

  /**
   * Atomically claim origin ownership of a room, or return the current owner.
   *
   * SETNX-based: only one instance ever wins for a given roomId. The TTL
   * acts as orphan recovery — if the owning instance dies without releasing,
   * another instance can claim after expiry.
   *
   * Stored separately from registerOrigin's InstanceInfo so the claim is
   * cheap (string SET) and the full info is only written after the cluster
   * is fully initialized. Edges that lose the claim must poll getOrigin()
   * to wait for the winner's cluster to come up.
   */
  async claimOwnership(roomId: string, instanceId: string): Promise<ClaimResult> {
    const key = `${KEY_PREFIX}${roomId}:owner`;
    const set = await this.redis.set(key, instanceId, "EX", OWNER_TTL_SECONDS, "NX");

    if (set === "OK") {
      this.logger.debug({ roomId, instanceId }, "RoomRegistry: ownership claimed");
      return { won: true, owner: instanceId };
    }

    const currentOwner = (await this.redis.get(key)) ?? instanceId;
    this.logger.debug({ roomId, instanceId, currentOwner }, "RoomRegistry: ownership claim lost");
    return { won: false, owner: currentOwner };
  }

  /**
   * F-34: refresh the short-TTL ownership claim. Called both on room activity
   * (join) and by RoomManager's periodic heartbeat so an idle but live origin
   * keeps its claim, while a crashed origin's claim expires in ≤OWNER_TTL_SECONDS.
   */
  async refreshOwnership(roomId: string, instanceId: string): Promise<void> {
    const key = `${KEY_PREFIX}${roomId}:owner`;
    // Lua: only refresh if we still own it (prevents resurrecting a key after another instance reclaimed)
    await this.redis.eval(
      `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('EXPIRE', KEYS[1], ARGV[2])
      end
      return 0
      `,
      1,
      key,
      instanceId,
      OWNER_TTL_SECONDS.toString(),
    );
  }

  // ─── Origin Info ────────────────────────────────────────────────

  /**
   * Register this instance as origin for a room (call AFTER cluster is initialized).
   *
   * F-32: previously a blind SETEX that reset `listenerCount` to whatever the
   * caller passed (always 0) on EVERY join, clobbering any prior value. Now it
   * preserves an existing `listenerCount` if the origin key already exists.
   * Non-atomic read-merge is acceptable: with the cross-edge LB layer removed
   * there is no concurrent `listenerCount` writer.
   */
  async registerOrigin(roomId: string, info: InstanceInfo): Promise<void> {
    const key = `${KEY_PREFIX}${roomId}:origin`;
    let listenerCount = info.listenerCount;
    const existing = await this.redis.get(key);
    if (existing) {
      try {
        const prev = JSON.parse(existing) as Partial<InstanceInfo>;
        if (typeof prev.listenerCount === "number") {
          listenerCount = prev.listenerCount;
        }
      } catch {
        // Corrupt prior value — fall through and overwrite with fresh info.
      }
    }
    await this.redis.setex(key, TTL_SECONDS, JSON.stringify({ ...info, listenerCount }));
    this.logger.debug({ roomId, instanceId: info.instanceId }, "RoomRegistry: origin registered");
  }

  /** Get origin info for a room */
  async getOrigin(roomId: string): Promise<InstanceInfo | null> {
    const key = `${KEY_PREFIX}${roomId}:origin`;
    const data = await this.redis.get(key);
    return data ? (JSON.parse(data) as InstanceInfo) : null;
  }

  // ─── Edges ──────────────────────────────────────────────────────
  // F-32: registerEdge removed (dead code — edges hash was never written by
  // any live path). getEdges/removeEdge retained only for the cascade
  // edge-deregistration endpoint; they operate on a never-populated hash while
  // cascade is disabled. See CASCADE.md.

  /** Remove an edge instance */
  async removeEdge(roomId: string, instanceId: string): Promise<void> {
    const key = `${KEY_PREFIX}${roomId}:edges`;
    await this.redis.hdel(key, instanceId);
    this.logger.debug({ roomId, instanceId }, "RoomRegistry: edge removed");
  }

  /** Get all edges for a room */
  async getEdges(roomId: string): Promise<InstanceInfo[]> {
    const key = `${KEY_PREFIX}${roomId}:edges`;
    const hash = await this.redis.hgetall(key);
    return Object.values(hash).map((v) => JSON.parse(v) as InstanceInfo);
  }

  // ─── Listener Counts / cross-edge LB ───────────────────────────
  // F-32: updateListenerCount, getTotalListeners, findBestInstance removed.
  // They were the cross-edge load-balancing surface — entirely dead code (zero
  // callers), and `registerOrigin` reset their backing `listenerCount` to 0 on
  // every join so the data was garbage anyway. Cascade multi-edge LB is a
  // deferred scale-gated project; rebuild from scratch if revived (CASCADE.md).

  // ─── Cleanup ────────────────────────────────────────────────────

  /** Remove all registry data for a room (origin info, edges, AND ownership claim). */
  async cleanup(roomId: string): Promise<void> {
    const ownerKey = `${KEY_PREFIX}${roomId}:owner`;
    const originKey = `${KEY_PREFIX}${roomId}:origin`;
    const edgesKey = `${KEY_PREFIX}${roomId}:edges`;
    await this.redis.del(ownerKey, originKey, edgesKey);
    this.logger.debug({ roomId }, "RoomRegistry: room cleaned up");
  }
}
