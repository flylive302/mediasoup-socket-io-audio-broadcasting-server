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
 *   POST /admin/drain   — enter drain mode
 *   GET  /admin/status  — current instance status
 */
import type { FastifyPluginAsync } from "fastify";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import { config } from "@src/config/index.js";
import { logger } from "./logger.js";

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
  opts?: { timeoutMs?: number; onComplete?: (report: DrainReport) => void },
): void {
  if (draining) {
    logger.warn("Drain mode already active");
    return;
  }

  draining = true;
  drained = false;
  lastDrainReport = null;
  drainStartedAt = Date.now();
  drainTimeoutMs = opts?.timeoutMs ?? 600_000;
  onDrainComplete = opts?.onComplete ?? null;

  logger.info(
    { timeoutMs: drainTimeoutMs },
    "🔄 Drain mode activated — rejecting new connections, waiting for rooms to close",
  );

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
  const report: DrainReport = { outcome, roomsStillOpen, durationMs };
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
 * Reset drain state (for testing)
 */
export function resetDrain(): void {
  draining = false;
  drained = false;
  drainStartedAt = null;
  lastDrainReport = null;
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
      // Auth check
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      if (internalKey !== config.LARAVEL_INTERNAL_KEY) {
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
     * GET /admin/status
     * Current instance status. AUDIT-008 FIX: requires X-Internal-Key.
     */
    fastify.get("/admin/status", async (request, reply) => {
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      if (internalKey !== config.LARAVEL_INTERNAL_KEY) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      return {
        draining,
        drained,
        drainOutcome: lastDrainReport?.outcome ?? null,
        roomsStillOpen: lastDrainReport?.roomsStillOpen ?? null,
        drainStartedAt: drainStartedAt ? new Date(drainStartedAt).toISOString() : null,
        rooms: roomManager.getRoomCount(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    });
  };
};
