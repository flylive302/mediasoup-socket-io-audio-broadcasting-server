/**
 * User Room Repository - Redis-backed userId → roomId tracking
 *
 * Extracted from UserSocketRepository (RL-015 SRP fix).
 * Tracks which room a user is currently in, used by the "Track" feature.
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";

const USER_ROOM_KEY = (userId: number) => `user:${userId}:room`;

// TTL for room entries (24 hours - cleanup for stale entries)
const ROOM_TTL_SECONDS = 86400;

export class UserRoomRepository {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  /**
   * Set user's current room
   * Called when user joins a room
   * Uses TTL to auto-expire in case disconnect doesn't fire (abnormal disconnect)
   */
  async setUserRoom(userId: number, roomId: string): Promise<boolean> {
    try {
      const key = USER_ROOM_KEY(userId);
      // If user remains in room, this gets refreshed on rejoin/reconnect
      await this.redis.setex(key, ROOM_TTL_SECONDS, roomId);
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
