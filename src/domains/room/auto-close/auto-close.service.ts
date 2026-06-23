/**
 * Room Auto-Close Service
 * Manages room inactivity detection and automatic room closure
 */
import type { Redis } from "ioredis";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { PresenceTracker } from "../presence-tracker.js";
import { AutoCloseEvaluator } from "./auto-close-evaluator.js";

const ACTIVITY_KEY = (roomId: string) => `room:${roomId}:activity`;
const STATE_KEY = (roomId: string) => `room:state:${roomId}`;

export class AutoCloseService {
  private readonly evaluator: AutoCloseEvaluator;

  constructor(
    private readonly redis: Redis,
    private readonly presenceTracker: PresenceTracker,
    evaluator: AutoCloseEvaluator = new AutoCloseEvaluator(),
  ) {
    this.evaluator = evaluator;
  }

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
   * Get all rooms that should be closed.
   *
   * Two-phase (realtime-01):
   *  1. CHEAP candidate filter — SCAN room:state:* + one pipelined EXISTS+GET
   *     per room: a candidate has an expired activity key AND advisory count 0.
   *     One round-trip regardless of room count; bounds the costly step below.
   *  2. PRESENCE confirm — only for candidates, query real socket presence
   *     (`PresenceTracker`) and run the pure `AutoCloseEvaluator`. A Room is
   *     closed only when real presence is genuinely zero (fixes Cause B: the
   *     advisory integer can under-count a still-connected socket) AND has
   *     stayed zero past the grace window. The over-count case (integer > 0 but
   *     truly empty) self-heals via the heartbeat reconcile, which sets owned
   *     Rooms' integer = presence every ~30s so they become candidates.
   */
  async getInactiveRoomIds(): Promise<string[]> {
    const candidates = await this.getCandidateRoomIds();
    if (candidates.length === 0) return [];

    const now = Date.now();
    const inactive: string[] = [];
    for (const roomId of candidates) {
      try {
        const present = await this.presenceTracker.present(roomId);
        this.presenceTracker.observe(roomId, present, now);
        const shouldClose = this.evaluator.shouldClose({
          interactivePresent: present,
          // Broadcast tier (mode/Speaker keep-alive) lands in realtime-08/09;
          // until then every Room is interactive and presence is the gate.
          speakerCount: 0,
          mode: "interactive",
          activityExpired: true, // candidacy already required the activity key expired
          zeroSince: this.presenceTracker.getZeroSince(roomId),
          now,
          graceMs: config.ROOM_PRESENCE_GRACE_MS,
        });
        if (shouldClose) inactive.push(roomId);
      } catch (err) {
        // Fail safe: a presence-check error must never close a live Room.
        logger.error({ err, roomId }, "Presence confirm failed; keeping room");
      }
    }
    return inactive;
  }

  /**
   * Phase 1: cheap candidate filter — Rooms whose activity key expired AND whose
   * advisory participant integer reads 0. Uses a single Redis pipeline for all
   * EXISTS + GET calls instead of N×2 parallel calls.
   */
  private async getCandidateRoomIds(): Promise<string[]> {
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

      const candidates: string[] = [];
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
          candidates.push(roomIds[i]!);
        }
      }

      return candidates;
    } catch (err) {
      logger.error({ err }, "Failed to get inactive rooms");
      return [];
    }
  }
}

