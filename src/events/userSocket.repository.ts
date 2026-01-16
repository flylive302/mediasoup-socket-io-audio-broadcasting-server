/**
 * User Socket Repository - Redis-backed userId → socketId mapping
 * Enables routing private events to users across horizontally scaled instances
 *
 * Pattern: Follows SeatRepository design with Redis Sets for multi-socket support
 */
import type { Redis } from "ioredis";
import { logger } from "../core/logger.js";

// Redis key pattern
const USER_SOCKETS_KEY = (userId: number) => `user:${userId}:sockets`;

// TTL for socket entries (24 hours - cleanup for stale entries)
const SOCKET_TTL_SECONDS = 86400;

export class UserSocketRepository {
  constructor(private readonly redis: Redis) {}

  /**
   * Register a socket for a user
   * Called when socket connects and authenticates
   */
  async registerSocket(userId: number, socketId: string): Promise<boolean> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      await this.redis.sadd(key, socketId);
      // Refresh TTL on each registration
      await this.redis.expire(key, SOCKET_TTL_SECONDS);

      logger.debug({ userId, socketId }, "Socket registered for user");
      return true;
    } catch (err) {
      logger.error({ err, userId, socketId }, "Failed to register socket");
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
      const removed = await this.redis.srem(key, socketId);

      if (removed > 0) {
        logger.debug({ userId, socketId }, "Socket unregistered for user");
      }

      // Clean up key if no sockets remain
      const remaining = await this.redis.scard(key);
      if (remaining === 0) {
        await this.redis.del(key);
      }

      return true;
    } catch (err) {
      logger.error({ err, userId, socketId }, "Failed to unregister socket");
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
      logger.error({ err, userId }, "Failed to get socket IDs");
      return [];
    }
  }

  /**
   * Check if a user has any active sockets
   */
  async hasActiveSockets(userId: number): Promise<boolean> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      const count = await this.redis.scard(key);
      return count > 0;
    } catch (err) {
      logger.error({ err, userId }, "Failed to check active sockets");
      return false;
    }
  }

  /**
   * Clear all sockets for a user
   * Used during cleanup or force logout
   */
  async clearUser(userId: number): Promise<boolean> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      await this.redis.del(key);
      logger.debug({ userId }, "Cleared all sockets for user");
      return true;
    } catch (err) {
      logger.error({ err, userId }, "Failed to clear user sockets");
      return false;
    }
  }

  /**
   * Get count of active sockets for a user
   */
  async getSocketCount(userId: number): Promise<number> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      return await this.redis.scard(key);
    } catch (err) {
      logger.error({ err, userId }, "Failed to get socket count");
      return 0;
    }
  }
}
