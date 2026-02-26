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

let draining = false;
let drained = false;
let drainStartedAt: number | null = null;
let drainTimeoutMs = 600_000; // 10 minutes default
let drainTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let drainPollHandle: ReturnType<typeof setInterval> | null = null;

// Callbacks
let onDrainComplete: (() => void) | null = null;

/**
 * Check if the instance is currently draining
 */
export function isDraining(): boolean {
  return draining;
}

/**
 * Check if the instance has finished draining (all rooms closed)
 */
export function isDrained(): boolean {
  return drained;
}

/**
 * Start drain mode.
 * - Sets draining flag (health goes 503)
 * - Starts polling room count
 * - Triggers force-drain after timeout
 */
export function startDrain(
  roomManager: RoomManager,
  opts?: { timeoutMs?: number; onComplete?: () => void },
): void {
  if (draining) {
    logger.warn("Drain mode already active");
    return;
  }

  draining = true;
  drained = false;
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
      completeDrain("all_rooms_closed");
    }
  }, 5_000);

  // Force-drain timeout
  drainTimeoutHandle = setTimeout(() => {
    logger.warn(
      { timeoutMs: drainTimeoutMs },
      "⚠️ Drain timeout reached — force-completing drain",
    );
    completeDrain("timeout");
  }, drainTimeoutMs);
}

/**
 * Complete the drain process
 */
function completeDrain(reason: string): void {
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
  logger.info(
    { reason, durationMs },
    "✅ Drain complete — instance ready for termination",
  );

  onDrainComplete?.();
}

/**
 * Reset drain state (for testing)
 */
export function resetDrain(): void {
  draining = false;
  drained = false;
  drainStartedAt = null;
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
        timeoutSeconds: timeoutSec,
      });
    });

    /**
     * GET /admin/status
     * Current instance status (no auth required — internal network only)
     */
    fastify.get("/admin/status", async () => {
      return {
        draining,
        drained,
        drainStartedAt: drainStartedAt ? new Date(drainStartedAt).toISOString() : null,
        rooms: roomManager.getRoomCount(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    });
  };
};
