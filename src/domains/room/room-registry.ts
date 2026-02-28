/**
 * Room Registry — Redis-backed cascade topology tracker
 *
 * Tracks which instances host each room (origin vs. edge) and their
 * listener counts for load-balanced routing decisions.
 *
 * Redis key schema:
 *   cascade:room:{roomId}:origin  → JSON string { instanceId, ip, port, listenerCount }
 *   cascade:room:{roomId}:edges   → Hash { [instanceId]: JSON string { ip, port, listenerCount } }
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
const TTL_SECONDS = 86_400; // 24 hours (matches RoomStateRepository)

export class RoomRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  // ─── Origin ─────────────────────────────────────────────────────

  /** Register this instance as origin for a room */
  async registerOrigin(roomId: string, info: InstanceInfo): Promise<void> {
    const key = `${KEY_PREFIX}${roomId}:origin`;
    await this.redis.setex(key, TTL_SECONDS, JSON.stringify(info));
    this.logger.debug({ roomId, instanceId: info.instanceId }, "RoomRegistry: origin registered");
  }

  /** Get origin info for a room */
  async getOrigin(roomId: string): Promise<InstanceInfo | null> {
    const key = `${KEY_PREFIX}${roomId}:origin`;
    const data = await this.redis.get(key);
    return data ? (JSON.parse(data) as InstanceInfo) : null;
  }

  // ─── Edges ──────────────────────────────────────────────────────

  /** Register an edge instance for a room */
  async registerEdge(roomId: string, info: InstanceInfo): Promise<void> {
    const key = `${KEY_PREFIX}${roomId}:edges`;
    await this.redis.hset(key, info.instanceId, JSON.stringify(info));
    await this.redis.expire(key, TTL_SECONDS);
    this.logger.debug({ roomId, instanceId: info.instanceId }, "RoomRegistry: edge registered");
  }

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

  // ─── Listener Counts ───────────────────────────────────────────

  /**
   * Atomically adjust the listener count for an instance (origin or edge).
   * Returns the new listener count.
   */
  async updateListenerCount(
    roomId: string,
    instanceId: string,
    delta: number,
  ): Promise<number> {
    // Try origin first
    const origin = await this.getOrigin(roomId);
    if (origin && origin.instanceId === instanceId) {
      origin.listenerCount = Math.max(0, origin.listenerCount + delta);
      await this.registerOrigin(roomId, origin);
      return origin.listenerCount;
    }

    // Try edges
    const edgeKey = `${KEY_PREFIX}${roomId}:edges`;
    const raw = await this.redis.hget(edgeKey, instanceId);
    if (raw) {
      const edge = JSON.parse(raw) as InstanceInfo;
      edge.listenerCount = Math.max(0, edge.listenerCount + delta);
      await this.redis.hset(edgeKey, instanceId, JSON.stringify(edge));
      return edge.listenerCount;
    }

    this.logger.warn({ roomId, instanceId }, "RoomRegistry: instance not found for listener count update");
    return 0;
  }

  /** Get total listener count across origin + all edges */
  async getTotalListeners(roomId: string): Promise<number> {
    let total = 0;

    const origin = await this.getOrigin(roomId);
    if (origin) total += origin.listenerCount;

    const edges = await this.getEdges(roomId);
    for (const edge of edges) {
      total += edge.listenerCount;
    }

    return total;
  }

  /** Find the least-loaded instance (origin or edge) for a new listener */
  async findBestInstance(roomId: string): Promise<InstanceInfo> {
    const origin = await this.getOrigin(roomId);
    const edges = await this.getEdges(roomId);

    const candidates: InstanceInfo[] = [];
    if (origin) candidates.push(origin);
    candidates.push(...edges);

    if (candidates.length === 0) {
      throw new Error(`No instances found for room ${roomId}`);
    }

    // Return instance with fewest listeners
    let best = candidates[0]!;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i]!.listenerCount < best.listenerCount) {
        best = candidates[i]!;
      }
    }

    return best;
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /** Remove all registry data for a room */
  async cleanup(roomId: string): Promise<void> {
    const originKey = `${KEY_PREFIX}${roomId}:origin`;
    const edgesKey = `${KEY_PREFIX}${roomId}:edges`;
    await this.redis.del(originKey, edgesKey);
    this.logger.debug({ roomId }, "RoomRegistry: room cleaned up");
  }
}
