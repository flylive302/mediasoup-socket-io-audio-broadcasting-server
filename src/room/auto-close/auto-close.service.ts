/**
 * Room Auto-Close Service
 * Manages room inactivity detection and automatic room closure
 */
import type { Redis } from "ioredis";
import { config } from "../../config/index.js";
import { logger } from "../../core/logger.js";

const ACTIVITY_KEY = (roomId: string) => `room:${roomId}:activity`;

export class AutoCloseService {
  constructor(private readonly redis: Redis) {}

  /**
   * Record activity for a room (resets inactivity timer)
   * Called on: join, leave, seat actions, chat, gifts, etc.
   */
  async recordActivity(roomId: string): Promise<void> {
    try {
      // Set activity timestamp with TTL (auto-expires)
      await this.redis.set(
        ACTIVITY_KEY(roomId),
        Date.now().toString(),
        "PX",
        config.ROOM_INACTIVITY_TIMEOUT_MS
      );
    } catch (err) {
      logger.error({ err, roomId }, "Failed to record room activity");
    }
  }

  /**
   * Check if a room has activity (not expired)
   */
  async hasActivity(roomId: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(ACTIVITY_KEY(roomId));
      return exists === 1;
    } catch (err) {
      logger.error({ err, roomId }, "Failed to check room activity");
      return true; // Fail safe: don't close on error
    }
  }

  /**
   * Clear activity key (when room is manually closed)
   */
  async clearActivity(roomId: string): Promise<void> {
    try {
      await this.redis.del(ACTIVITY_KEY(roomId));
    } catch (err) {
      logger.error({ err, roomId }, "Failed to clear room activity");
    }
  }

  /**
   * Get all rooms that have no recent activity
   * (Their activity keys have expired, but room state still exists)
   */
  async getInactiveRoomIds(): Promise<string[]> {
    try {
      // Get all room state keys
      const roomStateKeys = await this.redis.keys("room:state:*");
      const inactiveRooms: string[] = [];

      for (const key of roomStateKeys) {
        const roomId = key.replace("room:state:", "");
        const hasActivity = await this.hasActivity(roomId);
        
        if (!hasActivity) {
          inactiveRooms.push(roomId);
        }
      }

      return inactiveRooms;
    } catch (err) {
      logger.error({ err }, "Failed to get inactive rooms");
      return [];
    }
  }
}
