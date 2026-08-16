/**
 * Room Auto-Close Service
 * Manages room inactivity detection and automatic room closure
 */
import type { Redis } from "ioredis";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { PresenceTracker } from "../presence-tracker.js";
import { AutoCloseEvaluator } from "./auto-close-evaluator.js";
import { recordRedisDegradation } from "@src/shared/redis-degradation.js";

const ACTIVITY_KEY = (roomId: string) => `room:${roomId}:activity`;
const STATE_KEY_PREFIX = "room:state:";

/**
 * Bound on Phase-2 presence confirms per sweep. Each confirm is a (bounded)
 * cross-node fetchSockets; after a mass-crash a backlog of stale room:state
 * keys could otherwise stretch one sweep for minutes. Overflow candidates are
 * simply picked up by later sweeps (poll interval 30s).
 */
const MAX_PRESENCE_CHECKS_PER_SWEEP = 50;

/**
 * aws-production/19 (msab-autoclose-full-keyspace-scan-per-instance): with
 * affinity on, the hot sweep scopes to locally-owned rooms; the fleet-wide
 * SCAN survives only as a rare ORPHAN safety net — every Nth sweep, and only
 * admitting rooms with NO owner claim (a crashed instance's rooms would
 * otherwise never be closed by anyone and stay is_live=true in Laravel
 * forever). 10 × 30s poll ≈ a 5-minute orphan-detection ceiling, on top of
 * the 90s ownership TTL that must lapse first.
 */
const ORPHAN_SWEEP_EVERY = 10;

/** Mirrors RoomRegistry's CAS claim key (`cascade:room:{id}:owner`). */
const OWNER_KEY = (roomId: string) => `cascade:room:${roomId}:owner`;

export class AutoCloseService {
  private readonly evaluator: AutoCloseEvaluator;

  /** Counts owned-scope sweeps to pace the orphan safety net. */
  private sweepCount = 0;

  constructor(
    private readonly redis: Redis,
    private readonly presenceTracker: PresenceTracker,
    evaluator: AutoCloseEvaluator = new AutoCloseEvaluator(),
    /** Rooms this instance hosts (RoomManager's local map). Null = fleet-scan only. */
    private readonly getLocalRoomIds: (() => string[]) | null = null,
    private readonly affinityEnabled: () => boolean = () =>
      config.AFFINITY_ENABLED,
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
      recordRedisDegradation("auto-close", "write");
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
        recordRedisDegradation("auto-close", "reconcile");
        logger.error({ err, roomId }, "Presence confirm failed; keeping room");
      }
    }
    return inactive;
  }

  /**
   * Phase 1: cheap candidate filter — Rooms whose activity key expired.
   *
   * aws-production/19: with affinity on and a local registry wired, the hot
   * path is bounded by THIS instance's rooms (no keyspace SCAN); the fleet
   * SCAN runs only as the paced orphan safety net. Affinity off: the original
   * fleet-wide SCAN, unchanged.
   */
  private async getCandidateRoomIds(): Promise<string[]> {
    if (this.affinityEnabled() && this.getLocalRoomIds) {
      return this.getOwnedScopeCandidates();
    }
    return this.getFleetScanCandidates();
  }

  private async getOwnedScopeCandidates(): Promise<string[]> {
    this.sweepCount++;
    const localRoomIds = this.getLocalRoomIds!();
    const candidates = await this.filterActivityExpired(localRoomIds);

    if (this.sweepCount % ORPHAN_SWEEP_EVERY !== 0) return candidates;

    // Orphan safety net: fleet-scanned rooms that are not local AND have no
    // owner claim anywhere. Rooms owned elsewhere are left to their owner.
    try {
      const scanned = await this.getFleetScanCandidates();
      const localSet = new Set(localRoomIds);
      const foreign = scanned.filter((roomId) => !localSet.has(roomId));
      if (foreign.length === 0) return candidates;

      const pipeline = this.redis.pipeline();
      for (const roomId of foreign) {
        pipeline.exists(OWNER_KEY(roomId));
      }
      const results = await pipeline.exec();
      if (!results) return candidates;

      const orphans: string[] = [];
      for (let i = 0; i < foreign.length; i++) {
        const existsResult = results[i];
        // Fail safe: a Redis error must never make a room look ownerless.
        if (existsResult?.[0]) continue;
        if (existsResult?.[1] === 0) orphans.push(foreign[i]!);
      }

      if (orphans.length > 0) {
        logger.warn(
          { count: orphans.length },
          "AutoClose: orphan sweep admitted ownerless rooms",
        );
      }
      return [...candidates, ...orphans];
    } catch (err) {
      recordRedisDegradation("auto-close", "read");
      logger.error({ err }, "AutoClose: orphan sweep failed; local candidates only");
      return candidates;
    }
  }

  private async getFleetScanCandidates(): Promise<string[]> {
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

      return this.filterActivityExpired(roomIds);
    } catch (err) {
      recordRedisDegradation("auto-close", "read");
      logger.error({ err }, "Failed to get inactive rooms");
      return [];
    }
  }

  /**
   * One pipelined EXISTS per room, one round-trip regardless of room count.
   * A room is a candidate when its activity key has expired.
   */
  private async filterActivityExpired(roomIds: string[]): Promise<string[]> {
    if (roomIds.length === 0) return [];

    try {
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
      recordRedisDegradation("auto-close", "read");
      logger.error({ err }, "Failed to get inactive rooms");
      return [];
    }
  }
}

