/**
 * Internal API — Instance-to-instance communication for SFU cascade
 *
 * HTTP endpoints registered on the existing Fastify server for
 * edge ↔ origin pipe negotiation and cascade health checks.
 *
 * All endpoints require X-Internal-Key header matching config.INTERNAL_API_KEY.
 *
 * Phase 5A: /internal/health is fully functional.
 *           /internal/pipe/* endpoints are stubbed (return 501).
 *           Pipe logic is wired in Phase 5B.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@src/config/index.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RoomRegistry } from "@src/domains/room/room-registry.js";

export const createInternalRoutes = (
  roomManager: RoomManager,
  _roomRegistry: RoomRegistry,
): FastifyPluginAsync => {
  return async (fastify) => {
    // ─── Auth Hook ──────────────────────────────────────────────
    fastify.addHook("onRequest", async (request, reply) => {
      // Skip auth if cascade is not configured
      if (!config.INTERNAL_API_KEY) {
        return reply.code(503).send({
          status: "error",
          message: "Cascade not configured (INTERNAL_API_KEY not set)",
        });
      }

      const key = request.headers["x-internal-key"] as string | undefined;
      if (key !== config.INTERNAL_API_KEY) {
        return reply.code(401).send({
          status: "error",
          message: "Unauthorized",
        });
      }
    });

    // ─── Health ─────────────────────────────────────────────────

    /**
     * GET /internal/health
     * Returns instance role, room count, listener count.
     */
    fastify.get("/internal/health", async () => {
      const roomCount = roomManager.getRoomCount();

      return {
        status: "ok",
        cascadeEnabled: config.CASCADE_ENABLED,
        instanceId: config.PUBLIC_IP || "unknown",
        roomCount,
        timestamp: new Date().toISOString(),
      };
    });

    // ─── Pipe Offer (stubbed for Phase 5A) ──────────────────────

    /**
     * POST /internal/pipe/offer
     * Edge → Origin: request a plainTransport pipe for a producer.
     *
     * Body: { roomId: string, producerId: string }
     * Response: { transportIp, transportPort, srtpParameters, rtpParameters }
     */
    fastify.post("/internal/pipe/offer", async (_request, reply) => {
      return reply.code(501).send({
        status: "error",
        message: "Not implemented — pipe negotiation available in Phase 5B",
      });
    });

    // ─── Pipe Close (stubbed for Phase 5A) ──────────────────────

    /**
     * POST /internal/pipe/close
     * Edge → Origin: close all pipes for a room.
     *
     * Body: { roomId: string, instanceId: string }
     */
    fastify.post("/internal/pipe/close", async (_request, reply) => {
      return reply.code(501).send({
        status: "error",
        message: "Not implemented — pipe close available in Phase 5B",
      });
    });
  };
};
