/**
 * User Socket Repository - Redis-backed userId → socketId mapping
 * Enables routing private events to users across horizontally scaled instances
 *
 * Pattern: Follows SeatRepository design with Redis Sets for multi-socket support
 */
import type { Redis } from "ioredis";
import type { Logger } from "../../infrastructure/logger.js";

// Redis key patterns
const USER_SOCKETS_KEY = (userId: number) => `user:${userId}:sockets`;
const USER_ROOM_KEY = (userId: number) => `user:${userId}:room`;

// TTL for socket entries (24 hours - cleanup for stale entries)
const SOCKET_TTL_SECONDS = 86400;

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
      await this.redis.sadd(key, socketId);
      // Refresh TTL on each registration
      await this.redis.expire(key, SOCKET_TTL_SECONDS);

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
      const removed = await this.redis.srem(key, socketId);

      if (removed > 0) {
        this.logger.debug({ userId, socketId }, "Socket unregistered for user");
      }

      // Clean up key if no sockets remain
      const remaining = await this.redis.scard(key);
      if (remaining === 0) {
        await this.redis.del(key);
      }

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

  /**
   * Check if a user has any active sockets
   */
  async hasActiveSockets(userId: number): Promise<boolean> {
    try {
      const key = USER_SOCKETS_KEY(userId);
      const count = await this.redis.scard(key);
      return count > 0;
    } catch (err) {
      this.logger.error({ err, userId }, "Failed to check active sockets");
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
      this.logger.debug({ userId }, "Cleared all sockets for user");
      return true;
    } catch (err) {
      this.logger.error({ err, userId }, "Failed to clear user sockets");
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
      this.logger.error({ err, userId }, "Failed to get socket count");
      return 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Room Tracking (for user:getRoom feature)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Set user's current room
   * Called when user joins a room
   * Uses TTL to auto-expire in case disconnect doesn't fire (abnormal disconnect)
   */
  async setUserRoom(userId: number, roomId: string): Promise<boolean> {
    try {
      const key = USER_ROOM_KEY(userId);
      // Use TTL (same as socket TTL) to auto-expire stale entries
      // If user remains in room, this gets refreshed on rejoin/reconnect
      await this.redis.setex(key, SOCKET_TTL_SECONDS, roomId);
      this.logger.debug({ userId, roomId }, "User room set");
      return true;
    } catch (err) {
      this.logger.error({ err, userId, roomId }, "Failed to set user room");
      return false;
    }
  }

  /**
   * Clear user's current room
   * Called when user leaves a room or disconnects
   */
  async clearUserRoom(userId: number): Promise<boolean> {
    try {
      const key = USER_ROOM_KEY(userId);
      await this.redis.del(key);
      this.logger.debug({ userId }, "User room cleared");
      return true;
    } catch (err) {
      this.logger.error({ err, userId }, "Failed to clear user room");
      return false;
    }
  }

  /**
   * Get user's current room
   * Returns null if user is not in any room
   */
  async getUserRoom(userId: number): Promise<string | null> {
    try {
      const key = USER_ROOM_KEY(userId);
      return await this.redis.get(key);
    } catch (err) {
      this.logger.error({ err, userId }, "Failed to get user room");
      return null;
    }
  }
}
