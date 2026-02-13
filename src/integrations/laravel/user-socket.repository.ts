/**
 * User Socket Repository - Redis-backed userId → socketId mapping
 * Enables routing private events to users across horizontally scaled instances
 *
 * Pattern: Follows SeatRepository design with Redis Sets for multi-socket support
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";

// Redis key patterns
const USER_SOCKETS_KEY = (userId: number) => `user:${userId}:sockets`;

// TTL for socket entries (24 hours - cleanup for stale entries)
const SOCKET_TTL_SECONDS = 86400;

// Lua: atomic SREM + conditional DEL (hoisted to avoid per-call string allocation)
const UNREGISTER_LUA = `
  redis.call('srem', KEYS[1], ARGV[1])
  if redis.call('scard', KEYS[1]) == 0 then
    redis.call('del', KEYS[1])
  end
  return 1
`;

export class UserSocketRepository {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  /**
   * Register a socket for a user
   * Called when socket connects and authenticates
   */
  async registerSocket(userId: number, socketId: string): Promise<boolean> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      // PERF-004 FIX: Pipeline SADD + EXPIRE in single round-trip
      await this.redis
        .multi()
        .sadd(key, socketId)
        .expire(key, SOCKET_TTL_SECONDS)
        .exec();

      this.logger.debug({ userId, socketId }, "Socket registered for user");
      return true;
    } catch (err) {
      this.logger.error({ err, userId, socketId }, "Failed to register socket");
      return false;
    }
  }

  /**
   * Unregister a socket for a user
   * Called when socket disconnects
   */
  async unregisterSocket(userId: number, socketId: string): Promise<boolean> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      await this.redis.eval(UNREGISTER_LUA, 1, key, socketId);

      this.logger.debug({ userId, socketId }, "Socket unregistered for user");
      return true;
    } catch (err) {
      this.logger.error({ err, userId, socketId }, "Failed to unregister socket");
      return false;
    }
  }

  /**
   * Get all socket IDs for a user
   * Returns empty array if user has no active sockets
   */
  async getSocketIds(userId: number): Promise<string[]> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      return await this.redis.smembers(key);
    } catch (err) {
      this.logger.error({ err, userId }, "Failed to get socket IDs");
      return [];
    }
  }

}
