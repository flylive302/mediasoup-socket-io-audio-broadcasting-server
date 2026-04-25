/**
 * Internal API — Instance-to-instance communication for SFU cascade
 *
 * HTTP endpoints registered on the existing Fastify server for
 * edge ↔ origin pipe negotiation and cascade health checks.
 *
 * All endpoints require X-Internal-Key header matching config.INTERNAL_API_KEY.
 *
 * Phase 5A: /internal/health — fully functional.
 * Phase 5B: /internal/pipe/offer, /internal/pipe/close — wired to PipeManager.
 *           /internal/cascade/relay — signaling relay for cross-region events.
 */
import type { FastifyPluginAsync } from "fastify";
import type { Server } from "socket.io";
import { config } from "@src/config/index.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RoomRegistry } from "@src/domains/room/room-registry.js";
import type { PipeManager } from "@src/domains/media/pipe-manager.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import type { CascadeCoordinator } from "@src/domains/cascade/cascade-coordinator.js";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";
import { getMusicPlayerState } from "@src/domains/audio-player/index.js";
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";

// ─── Request Body Types ──────────────────────────────────────────

interface PipeOfferBody {
  roomId: string;
  producerId: string;
  edgeIp: string;
  edgePort: number;
  edgeRtpCapabilities: import("mediasoup").types.RtpCapabilities;
}

interface PipeCloseBody {
  roomId: string;
  edgeInstanceId: string;
}

interface CascadeRelayBody {
  roomId: string;
  event: string;
  data: unknown;
  sourceInstanceId: string;
}

// ─── Factory ─────────────────────────────────────────────────────

export interface InternalRouteDeps {
  roomManager: RoomManager;
  roomRegistry: RoomRegistry;
  pipeManager: PipeManager;
  cascadeRelay: CascadeRelay | null;
  cascadeCoordinator: CascadeCoordinator | null;
  io: Server | null;
  seatRepository: SeatRepository;
  redis: Redis;
}

export const createInternalRoutes = (
  deps: InternalRouteDeps,
): FastifyPluginAsync => {
  return async (fastify) => {
    const { roomManager, roomRegistry, pipeManager, cascadeRelay, cascadeCoordinator, io, seatRepository, redis } = deps;

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

    // ─── Producer Discovery (B-1 Stage 2c) ─────────────────────

    /**
     * GET /internal/room/:id/producers
     * Edge → Origin: list all live source producers in a room so a newly
     * attaching edge can pipe each speaker that joined before the edge.
     *
     * Without this, the edge only learns about NEW speakers via relayed
     * audio:newProducer events — pre-existing speakers remain inaudible
     * for listeners that connect through the edge.
     */
    fastify.get<{ Params: { id: string } }>("/internal/room/:id/producers", async (request, reply) => {
      const roomId = request.params.id;
      if (!roomId) {
        return reply.code(400).send({ status: "error", message: "Missing roomId" });
      }

      const cluster = roomManager.getRoom(roomId);
      if (!cluster) {
        return reply.code(404).send({ status: "error", message: "Room not found on this instance" });
      }

      return {
        status: "ok",
        producers: cluster.getSourceProducers(),
      };
    });

    /**
     * GET /internal/room/:id/participants
     * Edge → Origin: snapshot of users currently connected to origin's region
     * so an edge-region listener sees the full room on join.
     *
     * Without this, an edge user's join response only contains participants
     * from their local Redis (same-region sockets). They'd hear cross-region
     * speakers but the participant list and seat-user names would be wrong
     * until the next room:userJoined relay arrives.
     */
    fastify.get<{ Params: { id: string } }>("/internal/room/:id/participants", async (request, reply) => {
      const roomId = request.params.id;
      if (!roomId) {
        return reply.code(400).send({ status: "error", message: "Missing roomId" });
      }

      const cluster = roomManager.getRoom(roomId);
      if (!cluster) {
        return reply.code(404).send({ status: "error", message: "Room not found on this instance" });
      }

      if (!io) {
        return reply.code(503).send({ status: "error", message: "Socket.IO not initialized" });
      }

      // Speaker set from cluster — authoritative for isSpeaker (a user is a
      // speaker iff they have a producer on the source router).
      const speakerUserIds = new Set(cluster.getSourceProducers().map((p) => p.userId));

      const sockets = await io.in(roomId).fetchSockets();
      const seen = new Set<number>();
      const participants: Array<{
        id: number;
        name: string;
        signature: string;
        avatar: string;
        frame: string;
        gender: number;
        country: string;
        wealth_xp: string;
        charm_xp: string;
        vip_level: number;
        isSpeaker: boolean;
      }> = [];

      for (const s of sockets) {
        const u = s.data?.user;
        if (!u || seen.has(u.id)) continue;
        seen.add(u.id);
        participants.push({
          id: u.id,
          name: u.name,
          signature: u.signature,
          avatar: u.avatar,
          frame: u.frame,
          gender: u.gender,
          country: u.country,
          wealth_xp: u.wealth_xp,
          charm_xp: u.charm_xp,
          vip_level: u.vip_level ?? 0,
          isSpeaker: speakerUserIds.has(u.id),
        });
      }

      return { status: "ok", participants };
    });

    /**
     * GET /internal/room/:id/snapshot
     * Edge → Origin: room state held in origin's Redis (seats, locked seats,
     * seat count, music player). Edge regions have their own Redis so this
     * data is invisible to them locally — without this endpoint, edge users
     * see empty seat occupancy and no music state for cross-region rooms.
     *
     * Bundles four reads into one HTTP roundtrip since the join handler
     * needs all of them at the same point.
     */
    fastify.get<{ Params: { id: string }; Querystring: { seatCount?: string } }>(
      "/internal/room/:id/snapshot",
      async (request, reply) => {
        const roomId = request.params.id;
        if (!roomId) {
          return reply.code(400).send({ status: "error", message: "Missing roomId" });
        }

        const cluster = roomManager.getRoom(roomId);
        if (!cluster) {
          return reply.code(404).send({ status: "error", message: "Room not found on this instance" });
        }

        // Use origin's stored seatCount when caller didn't pass one — origin
        // is authoritative for room dimensions in cross-region cascade.
        const state = await roomManager.state.get(roomId);
        const seatCount = Number(request.query.seatCount) || state?.seatCount || 15;

        const [seatsRaw, musicPlayer] = await Promise.all([
          seatRepository.getSeats(roomId, seatCount),
          getMusicPlayerState(redis, roomId),
        ]);

        const seats: { seatIndex: number; userId: number; isMuted: boolean }[] = [];
        const lockedSeats: number[] = [];
        for (const s of seatsRaw) {
          if (s.userId) {
            seats.push({ seatIndex: s.index, userId: Number(s.userId), isMuted: s.muted });
          }
          if (s.locked) {
            lockedSeats.push(s.index);
          }
        }

        return {
          status: "ok",
          seats,
          lockedSeats,
          seatCount,
          musicPlayer,
        };
      },
    );

    // ─── Pipe Offer (Phase 5B) ─────────────────────────────────

    /**
     * POST /internal/pipe/offer
     * Edge → Origin: request a plainTransport pipe for a producer.
     *
     * Body: { roomId: string, producerId: string }
     * Response: { transportId, ip, port, srtpParameters?, rtpParameters }
     *
     * The origin creates a plainTransport that consumes the given producer.
     * The edge then creates its own transport pointing at the returned ip:port.
     */
    fastify.post("/internal/pipe/offer", async (request, reply) => {
      const { roomId, producerId, edgeIp, edgePort, edgeRtpCapabilities } =
        request.body as PipeOfferBody;

      if (!roomId || !producerId || !edgeIp || !edgePort || !edgeRtpCapabilities) {
        return reply.code(400).send({
          status: "error",
          message: "Missing roomId, producerId, edgeIp, edgePort, or edgeRtpCapabilities",
        });
      }

      const cluster = roomManager.getRoom(roomId);
      if (!cluster) {
        return reply.code(404).send({
          status: "error",
          message: "Room not found on this instance",
        });
      }

      const router = cluster.router;
      if (!router) {
        return reply.code(500).send({
          status: "error",
          message: "Room has no active router",
        });
      }

      try {
        // Create a plainTransport that consumes the producer's RTP using the
        // edge's caps so the consumer's rtpParameters reflect what the edge
        // can decode. Origin returns those rtpParameters so the edge produces
        // with matching SSRC/PT.
        const transportInfo = await pipeManager.createOriginPipe(
          router,
          producerId,
          roomId,
          { ip: edgeIp, port: edgePort },
          edgeRtpCapabilities,
        );

        // Use the instance's PUBLIC_IP instead of the local transport address
        // so the edge can reach it across the internet
        const publicIp = config.PUBLIC_IP || transportInfo.ip;

        logger.info(
          {
            roomId,
            producerId,
            transportId: transportInfo.transportId,
            publicIp,
            port: transportInfo.port,
          },
          "Pipe offer created for edge",
        );

        return {
          status: "ok",
          transportId: transportInfo.transportId,
          ip: publicIp,
          port: transportInfo.port,
          srtpParameters: transportInfo.srtpParameters ?? null,
          rtpParameters: transportInfo.consumerRtpParameters,
          kind: transportInfo.consumerKind,
        };
      } catch (err) {
        logger.error({ err, roomId, producerId }, "Failed to create pipe offer");
        return reply.code(500).send({
          status: "error",
          message: "Failed to create pipe transport",
        });
      }
    });

    // ─── Pipe Close (Phase 5B) ──────────────────────────────────

    /**
     * POST /internal/pipe/close
     * Edge → Origin: close all pipes for a room from a specific edge.
     *
     * Body: { roomId: string, edgeInstanceId: string }
     */
    fastify.post("/internal/pipe/close", async (request, reply) => {
      const { roomId, edgeInstanceId } = request.body as PipeCloseBody;

      if (!roomId) {
        return reply.code(400).send({
          status: "error",
          message: "Missing roomId",
        });
      }

      try {
        await pipeManager.closePipes(roomId);

        // Remove edge from registry if provided
        if (edgeInstanceId) {
          await roomRegistry.removeEdge(roomId, edgeInstanceId);
        }

        logger.info(
          { roomId, edgeInstanceId },
          "Pipes closed and edge unregistered",
        );

        return { status: "ok" };
      } catch (err) {
        logger.error({ err, roomId }, "Failed to close pipes");
        return reply.code(500).send({
          status: "error",
          message: "Failed to close pipes",
        });
      }
    });

    // ─── Cascade Relay (Phase 5B) ───────────────────────────────

    /**
     * POST /internal/cascade/relay
     * Receives a relayed socket event from a remote instance.
     * Broadcasts it to local users in the room.
     *
     * Body: { roomId, event, data, sourceInstanceId }
     */
    fastify.post("/internal/cascade/relay", async (request, reply) => {
      const body = request.body as CascadeRelayBody;
      const { roomId, event, data, sourceInstanceId } = body;

      if (!roomId || !event) {
        return reply.code(400).send({
          status: "error",
          message: "Missing roomId or event",
        });
      }

      // Prevent relay loops: don't re-relay from ourselves
      const selfId = config.PUBLIC_IP || "unknown";
      if (sourceInstanceId === selfId) {
        return { status: "ok", relayed: false, reason: "self" };
      }

      // Payload that will be broadcast to local sockets — may be rewritten
      // below for events that carry instance-local IDs (e.g. producerId).
      let broadcastData = data;

      // Handle special cascade lifecycle events BEFORE broadcasting so we can
      // rewrite payloads that reference origin-local IDs that local listeners
      // wouldn't be able to resolve.
      if (event === "__cascade:edge-registered" && cascadeRelay) {
        const edgeData = data as Record<string, string>;
        if (edgeData.edgeInstanceId && edgeData.edgeBaseUrl) {
          cascadeRelay.registerRemote(roomId, {
            instanceId: edgeData.edgeInstanceId,
            baseUrl: edgeData.edgeBaseUrl,
          });
        }
      } else if (event === "audio:newProducer" && cascadeCoordinator) {
        // The relayed payload's producerId is the ORIGIN's source producer ID.
        // Local listeners on this edge consume from the edge's local cluster,
        // whose pipedProducerMap is keyed by the edge's local producer ID.
        // We must await pipe setup, then swap producerId to the edge-local ID
        // before broadcasting — otherwise consume() will fail with "not piped".
        const producerData = data as Record<string, unknown>;
        const originProducerId = producerData.producerId;
        if (typeof originProducerId === "string") {
          try {
            const edgeProducerId = await cascadeCoordinator.handleRemoteNewProducer(
              roomId,
              originProducerId,
            );
            if (!edgeProducerId) {
              logger.warn(
                { roomId, originProducerId },
                "Cascade relay: edge pipe setup failed; suppressing audio:newProducer broadcast",
              );
              // Skip the local broadcast — listeners would just fail to consume.
              // Still forward to other remotes below so they get a chance.
              broadcastData = null;
            } else {
              broadcastData = { ...producerData, producerId: edgeProducerId };
            }
          } catch (err) {
            logger.error({ err, roomId, originProducerId }, "Failed to handle remote new producer");
            broadcastData = null;
          }
        }
      } else if (event === "audio:producerClosed" && cascadeCoordinator) {
        // Mirror of audio:newProducer: rewrite producerId to edge-local so
        // any frontend listener keying off it sees the right id, AND tear
        // down the edge pipe so listener consumers get producerclose.
        const producerData = data as Record<string, unknown>;
        const originProducerId = producerData.producerId;
        if (typeof originProducerId === "string") {
          try {
            const edgeProducerId = await cascadeCoordinator.handleRemoteProducerClosed(
              roomId,
              originProducerId,
            );
            if (edgeProducerId) {
              broadcastData = { ...producerData, producerId: edgeProducerId };
            }
            // If we never had a pipe for this producer, the local broadcast
            // is harmless — pass through with origin id; no listener should
            // be watching for it locally anyway.
          } catch (err) {
            logger.error({ err, roomId, originProducerId }, "Failed to handle remote producer closed");
          }
        }
      } else if (event === "room:closed" && cascadeCoordinator) {
        cascadeCoordinator.handleOriginClosed(roomId).catch((err) =>
          logger.error({ err, roomId }, "Failed to handle origin closed"),
        );
      }

      // Broadcast the event to local users in this room (after any rewrites)
      if (io && broadcastData !== null) {
        io.to(roomId).emit(event, broadcastData);
      }

      // Forward to other remote instances using the ORIGINAL data so each
      // hop performs its own producer-id rewrite (their edge IDs differ).
      if (cascadeRelay) {
        await cascadeRelay.relayToRemote(roomId, event, data, sourceInstanceId);
      }

      return { status: "ok", relayed: true };
    });
  };
};
