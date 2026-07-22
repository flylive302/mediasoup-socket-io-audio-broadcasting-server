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
const STATE_KEY_PREFIX = "room:state:";

/**
 * Bound on Phase-2 presence confirms per sweep. Each confirm is a (bounded)
 * cross-node fetchSockets; after a mass-crash a backlog of stale room:state
 * keys could otherwise stretch one sweep for minutes. Overflow candidates are
 * simply picked up by later sweeps (poll interval 30s).
 */
const MAX_PRESENCE_CHECKS_PER_SWEEP = 50;

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
   * Two-phase (realtime-01, admission gate reworked in msab-load-stability 09):
   *  1. CHEAP candidate filter — SCAN room:state:* + one pipelined EXISTS per
   *     room: a candidate is any room whose activity key expired. Candidacy
   *     deliberately does NOT consult the advisory participantCount integer:
   *     that integer is only healed by the owning instance's in-memory-scoped
   *     heartbeat, so a room whose instance crashed kept a stale count > 0
   *     forever and was never admitted — the orphan-room bug. Activity-TTL
   *     alone bounds Phase-2 volume, plus a per-sweep cap.
   *  2. PRESENCE confirm — only for candidates, query real socket presence
   *     (`PresenceTracker.reconcile`, which also heals the advisory integer
   *     fleet-wide) and run the pure `AutoCloseEvaluator`. A Room is closed
   *     only when real presence is genuinely zero (fixes Cause B: the
   *     advisory integer can under-count a still-connected socket) AND has
   *     stayed zero past the grace window.
   */
  async getInactiveRoomIds(): Promise<string[]> {
    const candidates = await this.getCandidateRoomIds();
    if (candidates.length === 0) return [];

    const now = Date.now();
    const inactive: string[] = [];
    for (const roomId of candidates.slice(0, MAX_PRESENCE_CHECKS_PER_SWEEP)) {
      try {
        // reconcile = real presence + heal advisory integer (update-if-exists,
        // can't resurrect a closed room) + feed the grace-window observation.
        const present = await this.presenceTracker.reconcile(roomId);
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
   * Phase 1: cheap candidate filter — Rooms whose activity key expired. One
   * pipelined EXISTS per room, one round-trip regardless of room count.
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
          `${STATE_KEY_PREFIX}*`,
          "COUNT",
          100,
        );
        cursor = nextCursor;
        roomStateKeys.push(...keys);
      } while (cursor !== "0");

      if (roomStateKeys.length === 0) return [];

      const roomIds = roomStateKeys.map((key) =>
        key.replace(STATE_KEY_PREFIX, ""),
      );

      // Single pipeline: batch all EXISTS calls
      const pipeline = this.redis.pipeline();
      for (const roomId of roomIds) {
        pipeline.exists(ACTIVITY_KEY(roomId));
      }
      const results = await pipeline.exec();
      if (!results) return [];

      const candidates: string[] = [];
      for (let i = 0; i < roomIds.length; i++) {
        const existsResult = results[i];

        // Fail safe: skip rooms where Redis errored
        if (existsResult?.[0]) continue;

        const hasActivity = existsResult?.[1] === 1;
        if (!hasActivity) {
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

