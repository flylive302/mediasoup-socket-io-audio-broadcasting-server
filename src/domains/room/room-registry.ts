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
   *
   * P-3 FIX: Uses Lua script for atomic read-modify-write to prevent
   * lost-update race under concurrent listener count adjustments.
   */
  async updateListenerCount(
    roomId: string,
    instanceId: string,
    delta: number,
  ): Promise<number> {
    const originKey = `${KEY_PREFIX}${roomId}:origin`;
    const edgesKey = `${KEY_PREFIX}${roomId}:edges`;

    // Lua script: try origin key first, then edge hash field
    const result = await this.redis.eval(
      `
      -- Try origin first
      local originData = redis.call('GET', KEYS[1])
      if originData then
        local origin = cjson.decode(originData)
        if origin.instanceId == ARGV[1] then
          origin.listenerCount = math.max(0, origin.listenerCount + tonumber(ARGV[2]))
          redis.call('SETEX', KEYS[1], ${TTL_SECONDS}, cjson.encode(origin))
          return origin.listenerCount
        end
      end

      -- Try edge hash
      local edgeData = redis.call('HGET', KEYS[2], ARGV[1])
      if edgeData then
        local edge = cjson.decode(edgeData)
        edge.listenerCount = math.max(0, edge.listenerCount + tonumber(ARGV[2]))
        redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(edge))
        return edge.listenerCount
      end

      return -1
      `,
      2,
      originKey,
      edgesKey,
      instanceId,
      delta.toString(),
    ) as number;

    if (result === -1) {
      this.logger.warn({ roomId, instanceId }, "RoomRegistry: instance not found for listener count update");
      return 0;
    }

    return result;
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
