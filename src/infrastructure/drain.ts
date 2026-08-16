/**
 * Drain Mode — Graceful instance draining for auto-scaling
 *
 * When drain mode is activated:
 * 1. Health endpoint returns 503 → NLB stops routing new connections
 * 2. Existing WebRTC rooms continue normally
 * 3. When all rooms close, instance signals "drained"
 * 4. If lifecycle hook token is present, completes ASG lifecycle action
 *
 * Admin routes:
 *   POST /admin/drain    — enter drain mode
 *   POST /admin/undrain  — cancel drain mode, return instance to rotation
 *   GET  /admin/status   — current instance status
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RepinBatchResult } from "@src/integrations/types.js";
import { config } from "@src/config/index.js";
import { logger } from "./logger.js";
import { matchesRotatableKey, parsePreviousKeys } from "@src/shared/keyRotation.js";

// ─── Drain State ────────────────────────────────────────────────────

/** Honest outcome of a completed drain — see DrainReport. */
export type DrainOutcome = "all_rooms_closed" | "timeout";

/**
 * Honest drain completion report. `outcome: "timeout"` means the ceiling
 * was hit with rooms still open — callers must never present that as a
 * plain "drained" success.
 */
export interface DrainReport {
  outcome: DrainOutcome;
  roomsStillOpen: number;
  durationMs: number;
  /**
   * Cumulative re-pin totals when the affinity re-pin loop ran (aws-production/20),
   * null when it didn't (affinity off / no client registered). Purely additive —
   * never changes what `outcome` means.
   */
  repin?: RepinSummary | null;
}

/** Cumulative totals across all re-pin batches of one drain. */
export interface RepinSummary {
  repinned: number;
  unplaced: number;
  remaining: number;
}

/**
 * The slice of LaravelClient the drain re-pin loop needs (aws-production/20).
 * Registered from the composition root so this module stays free of a direct
 * LaravelClient construction dependency.
 */
export interface DrainRepinClient {
  setInstanceDraining(draining: boolean): Promise<boolean>;
  repinRooms(limit: number): Promise<RepinBatchResult | null>;
}

/**
 * Rooms moved per re-pin batch. Bounded so one draining instance never lands
 * its whole Room set on the receiver at once (self-inflicted thundering herd).
 * Epic 3b inherits this as the receiving-capacity assumption: a 50%-fleet
 * refresh moves rooms at ≤ BATCH_SIZE per instance per BATCH_INTERVAL, so the
 * surviving half absorbs a paced trickle, not a step function.
 */
export const REPIN_BATCH_SIZE = 25;
export const REPIN_BATCH_INTERVAL_MS = 2_000;
/** Consecutive Laravel failures before the loop gives up (drain continues regardless). */
export const REPIN_MAX_CONSECUTIVE_FAILURES = 3;

let repinClient: DrainRepinClient | null = null;
let repinSummary: RepinSummary | null = null;

/** Wire the Laravel client the drain loop re-pins through. Null clears it (tests). */
export function registerDrainRepinClient(client: DrainRepinClient | null): void {
  repinClient = client;
}

let draining = false;
let drained = false;
let drainStartedAt: number | null = null;
let drainTimeoutMs = 600_000; // 10 minutes default
let drainTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let drainPollHandle: ReturnType<typeof setInterval> | null = null;
let lastDrainReport: DrainReport | null = null;

// Callbacks
let onDrainComplete: ((report: DrainReport) => void) | null = null;

/**
 * Check if the instance is currently draining
 */
export function isDraining(): boolean {
  return draining;
}

/**
 * Check if the drain process has finished (either all rooms closed, or the
 * ceiling was hit). Does NOT imply rooms actually closed — check
 * getDrainReport().outcome for the honest result.
 */
export function isDrained(): boolean {
  return drained;
}

/**
 * The honest report from the most recently completed drain, or null if no
 * drain has completed yet. `outcome: "timeout"` + `roomsStillOpen > 0` means
 * the ceiling was hit with rooms still open — never report that as success.
 */
export function getDrainReport(): DrainReport | null {
  return lastDrainReport;
}

/**
 * Start drain mode.
 * - Sets draining flag (health goes 503)
 * - Starts polling room count
 * - Triggers force-drain after timeout
 */
export function startDrain(
  roomManager: RoomManager,
  opts?: {
    timeoutMs?: number;
    onComplete?: (report: DrainReport) => void;
    /** Test seam; production reads config.AFFINITY_ENABLED. */
    affinityEnabled?: () => boolean;
  },
): void {
  if (draining) {
    logger.warn("Drain mode already active");
    return;
  }

  draining = true;
  drained = false;
  lastDrainReport = null;
  repinSummary = null;
  drainStartedAt = Date.now();
  drainTimeoutMs = opts?.timeoutMs ?? 600_000;
  onDrainComplete = opts?.onComplete ?? null;

  logger.info(
    { timeoutMs: drainTimeoutMs },
    "🔄 Drain mode activated — rejecting new connections, waiting for rooms to close",
  );

  // aws-production/20: under affinity, drain MOVES rooms (re-pins them to
  // healthy instances via Laravel) instead of only waiting them out. Runs
  // beside the poll/timeout machinery and never blocks or alters it — a
  // Laravel outage degrades drain back to exactly its pre-affinity behavior.
  const affinityEnabled = opts?.affinityEnabled ?? (() => config.AFFINITY_ENABLED);
  if (affinityEnabled() && repinClient) {
    void runRepinLoop(repinClient);
  }

  // Poll room count every 5 seconds
  drainPollHandle = setInterval(() => {
    const roomCount = roomManager.getRoomCount();
    logger.info({ roomCount }, "Drain poll: checking active rooms");

    if (roomCount === 0) {
      completeDrain("all_rooms_closed", 0);
    }
  }, 5_000);

  // Force-drain timeout
  drainTimeoutHandle = setTimeout(() => {
    const roomsStillOpen = roomManager.getRoomCount();
    logger.warn(
      { timeoutMs: drainTimeoutMs, roomsStillOpen },
      "⚠️ Drain ceiling reached — force-completing drain with rooms still open",
    );
    completeDrain("timeout", roomsStillOpen);
  }, drainTimeoutMs);
}

/**
 * The affinity drain re-pin loop (aws-production/20). Marks this instance
 * draining in Laravel's placement registry (so nothing re-pins ONTO it —
 * including a peer draining at the same time), then pulls bounded re-pin
 * batches until Laravel reports none of our rooms remain, progress stalls
 * (no healthy target), or the drain itself ends.
 *
 * Every exit path is honest: totals accumulate in `repinSummary`, which the
 * final DrainReport and /admin/status expose — a stalled loop never reads as
 * "all rooms moved".
 */
async function runRepinLoop(client: DrainRepinClient): Promise<void> {
  repinSummary = { repinned: 0, unplaced: 0, remaining: -1 };

  const acknowledged = await client.setInstanceDraining(true);
  if (!acknowledged) {
    logger.warn(
      "Laravel did not acknowledge the draining flag — re-pins may land back on this instance",
    );
  }

  let consecutiveFailures = 0;

  while (draining && !drained) {
    const batch = await client.repinRooms(REPIN_BATCH_SIZE);

    if (batch === null) {
      if (++consecutiveFailures >= REPIN_MAX_CONSECUTIVE_FAILURES) {
        logger.warn(
          { consecutiveFailures, repinSummary },
          "⚠️ Re-pin loop giving up after repeated Laravel failures — drain continues by waiting rooms out",
        );
        return;
      }
    } else {
      consecutiveFailures = 0;
      repinSummary.repinned += batch.repinned;
      repinSummary.unplaced += batch.unplaced;
      repinSummary.remaining = batch.remaining;

      logger.info({ batch, repinSummary }, "Drain re-pin batch applied");

      if (batch.remaining === 0) {
        logger.info({ repinSummary }, "✅ All rooms re-pinned away from this instance");
        return;
      }

      if (batch.repinned === 0) {
        logger.warn(
          { repinSummary },
          "⚠️ Re-pin loop stalled — no healthy target for the remaining rooms; drain continues by waiting them out",
        );
        return;
      }
    }

    await sleepUnref(REPIN_BATCH_INTERVAL_MS);
  }
}

/** setTimeout-based sleep that never keeps a shutting-down process alive. */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

/**
 * Complete the drain process. Builds the honest DrainReport — this is the
 * ONLY place drain completion is reported, so every caller (logs, HTTP
 * responses, onComplete callback) sees the same truthful outcome.
 */
function completeDrain(outcome: DrainOutcome, roomsStillOpen: number): void {
  if (drained) return;

  drained = true;

  // Clear timers
  if (drainPollHandle) {
    clearInterval(drainPollHandle);
    drainPollHandle = null;
  }
  if (drainTimeoutHandle) {
    clearTimeout(drainTimeoutHandle);
    drainTimeoutHandle = null;
  }

  const durationMs = drainStartedAt ? Date.now() - drainStartedAt : 0;
  const report: DrainReport = { outcome, roomsStillOpen, durationMs, repin: repinSummary };
  lastDrainReport = report;

  if (outcome === "all_rooms_closed") {
    logger.info(
      { outcome, durationMs },
      "✅ Drain complete — all rooms closed, instance ready for termination",
    );
  } else {
    logger.warn(
      { outcome, durationMs, roomsStillOpen },
      "⚠️ Drain ceiling reached — rooms still open, proceeding with shutdown anyway",
    );
  }

  onDrainComplete?.(report);
}

/**
 * Reset drain state.
 *
 * Shared by two callers: `POST /admin/undrain` (reversing a live drain, e.g.
 * a scale-in decision cancelled mid-flight) and tests. Clears every drain
 * var and both timers (poll interval + ceiling timeout) so a cancelled drain
 * cannot complete or re-flip the instance to drained later.
 */
export function resetDrain(): void {
  draining = false;
  drained = false;
  drainStartedAt = null;
  lastDrainReport = null;
  repinSummary = null;
  onDrainComplete = null;
  if (drainPollHandle) {
    clearInterval(drainPollHandle);
    drainPollHandle = null;
  }
  if (drainTimeoutHandle) {
    clearTimeout(drainTimeoutHandle);
    drainTimeoutHandle = null;
  }
}

// ─── Auth ───────────────────────────────────────────────────────────

/**
 * Shared X-Internal-Key check for all admin routes below. Pure extraction
 * of the guard that used to be duplicated inline in each handler — same
 * mechanism (rotation-overlap key match), same env vars.
 */
function isAuthorizedAdmin(request: FastifyRequest): boolean {
  const internalKey = request.headers["x-internal-key"] as string | undefined;
  return matchesRotatableKey(
    internalKey,
    config.LARAVEL_INTERNAL_KEY,
    parsePreviousKeys(config.LARAVEL_INTERNAL_KEY_PREVIOUS),
  );
}

// ─── Fastify Admin Routes ───────────────────────────────────────────

export const createAdminRoutes = (
  roomManager: RoomManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    /**
     * POST /admin/drain
     * Enter drain mode. Requires X-Internal-Key header.
     */
    fastify.post("/admin/drain", async (request, reply) => {
      if (!isAuthorizedAdmin(request)) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      if (draining) {
        return reply.code(200).send({
          status: "ok",
          message: "Already draining",
          draining: true,
          drained,
          drainOutcome: lastDrainReport?.outcome ?? null,
          roomsStillOpen: lastDrainReport?.roomsStillOpen ?? null,
        });
      }

      // Parse optional timeout from query
      const query = request.query as { timeout?: string };
      const timeoutSec = query.timeout ? parseInt(query.timeout, 10) : 600;
      const timeoutMs = timeoutSec * 1000;

      startDrain(roomManager, { timeoutMs });

      return reply.code(200).send({
        status: "ok",
        message: "Drain mode activated",
        draining: true,
        drained: false,
        drainOutcome: null,
        roomsStillOpen: null,
        timeoutSeconds: timeoutSec,
      });
    });

    /**
     * POST /admin/undrain
     * Cancel drain mode and return the instance to rotation. Reverses
     * `POST /admin/drain`: clears the draining/drained flags and cancels
     * both the poll interval and the ceiling timeout, so a drain already
     * in flight cannot complete out from under the cancellation. Requires
     * X-Internal-Key header. Idempotent — safe to call repeatedly, and
     * safe on an instance that was never drained.
     */
    fastify.post("/admin/undrain", async (request, reply) => {
      if (!isAuthorizedAdmin(request)) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      const wasDraining = isDraining();
      const discardedReport = getDrainReport();

      resetDrain();

      // aws-production/20: return the instance to Laravel's placement pool.
      // Fire-and-forget — a failure here self-heals on the next drain cycle
      // and must not fail the undrain itself.
      if (wasDraining && repinClient) {
        repinClient.setInstanceDraining(false).catch((error: unknown) => {
          logger.warn({ error }, "Failed to clear draining flag in Laravel");
        });
      }

      logger.info(
        { wasDraining, discardedReport },
        "▶️ Drain cancelled — instance returned to rotation",
      );

      return reply.code(200).send({
        status: "ok",
        message: wasDraining ? "Drain cancelled — instance returned to rotation" : "Not draining",
        draining: false,
        drained: false,
        drainOutcome: null,
        roomsStillOpen: null,
      });
    });

    /**
     * GET /admin/status
     * Current instance status. AUDIT-008 FIX: requires X-Internal-Key.
     */
    fastify.get("/admin/status", async (request, reply) => {
      if (!isAuthorizedAdmin(request)) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      return {
        draining,
        drained,
        drainOutcome: lastDrainReport?.outcome ?? null,
        roomsStillOpen: lastDrainReport?.roomsStillOpen ?? null,
        repin: repinSummary,
        drainStartedAt: drainStartedAt ? new Date(drainStartedAt).toISOString() : null,
        rooms: roomManager.getRoomCount(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    });
  };
};
