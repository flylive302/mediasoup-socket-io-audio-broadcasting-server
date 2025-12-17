/**
 * Room Auto-Close Service
 * Manages room inactivity detection and automatic room closure
 */
import type { Redis } from "ioredis";
import { config } from "../../config/index.js";
import { logger } from "../../core/logger.js";

const ACTIVITY_KEY = (roomId: string) => `room:${roomId}:activity`;
const STATE_KEY = (roomId: string) => `room:state:${roomId}`;

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
        config.ROOM_INACTIVITY_TIMEOUT_MS,
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
   * Get participant count from room state
   */
  async getParticipantCount(roomId: string): Promise<number> {
    try {
      const data = await this.redis.get(STATE_KEY(roomId));
      if (!data) return 0;
      const state = JSON.parse(data);
      return state.participantCount ?? 0;
    } catch (err) {
      logger.error({ err, roomId }, "Failed to get participant count");
      return 1; // Fail safe: assume there are participants on error
    }
  }

  /**
   * Get all rooms that should be closed
   * (Their activity keys have expired AND they have 0 participants)
   */
  async getInactiveRoomIds(): Promise<string[]> {
    try {
      // Get all room state keys
      const roomStateKeys = await this.redis.keys("room:state:*");
      const inactiveRooms: string[] = [];

      for (const key of roomStateKeys) {
        const roomId = key.replace("room:state:", "");
        const hasActivity = await this.hasActivity(roomId);
        const participantCount = await this.getParticipantCount(roomId);

        // Only close if no activity AND no participants
        if (!hasActivity && participantCount === 0) {
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

