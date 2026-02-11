/**
 * Room Auto-Close Service
 * Manages room inactivity detection and automatic room closure
 */
import type { Redis } from "ioredis";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";

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
   * Get all rooms that should be closed
   * (Their activity keys have expired AND they have 0 participants)
   *
   * Uses a single Redis pipeline for all EXISTS + GET calls instead of
   * N×2 parallel calls — one round-trip regardless of room count.
   */
  async getInactiveRoomIds(): Promise<string[]> {
    try {
      // BL-004 FIX: Use SCAN instead of KEYS to avoid blocking Redis
      const roomStateKeys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          "room:state:*",
          "COUNT",
          100,
        );
        cursor = nextCursor;
        roomStateKeys.push(...keys);
      } while (cursor !== "0");

      if (roomStateKeys.length === 0) return [];

      const roomIds = roomStateKeys.map((key) =>
        key.replace("room:state:", ""),
      );

      // Single pipeline: batch all EXISTS + GET calls
      const pipeline = this.redis.pipeline();
      for (const roomId of roomIds) {
        pipeline.exists(ACTIVITY_KEY(roomId));
        pipeline.get(STATE_KEY(roomId));
      }
      const results = await pipeline.exec();
      if (!results) return [];

      const inactive: string[] = [];
      for (let i = 0; i < roomIds.length; i++) {
        const existsResult = results[i * 2];
        const stateResult = results[i * 2 + 1];

        // Fail safe: skip rooms where Redis errored
        if (existsResult?.[0] || stateResult?.[0]) continue;

        const hasActivity = existsResult?.[1] === 1;
        const stateStr = stateResult?.[1] as string | null;
        let participantCount = 1; // Fail safe: assume participants on parse error
        if (stateStr) {
          try {
            const state = JSON.parse(stateStr);
            participantCount = state.participantCount ?? 0;
          } catch {
            // Keep fail-safe default
          }
        } else {
          participantCount = 0;
        }

        if (!hasActivity && participantCount === 0) {
          inactive.push(roomIds[i]!);
        }
      }

      return inactive;
    } catch (err) {
      logger.error({ err }, "Failed to get inactive rooms");
      return [];
    }
  }
}

