/**
 * CQ-001 FIX: Media handler migrated to createHandler.
 * All 7 socket events now use createHandler() for consistent:
 * - Zod validation
 * - Correlation IDs
 * - Error handling
 * - Duration metrics logging
 */
import type * as mediasoup from "mediasoup";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  transportCreateSchema,
  transportConnectSchema,
  audioProduceSchema,
  audioConsumeSchema,
  consumerResumeSchema,
  selfMuteSchema,
} from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { Errors } from "@src/shared/errors.js";
import { getIceServers } from "@src/config/iceServers.js";
import type { Socket } from "socket.io";

// 1. Create Transport
const transportCreateHandler = createHandler(
  "transport:create",
  transportCreateSchema,
  async (payload, socket, context) => {
    const { type, roomId } = payload;

    // SEC-MED-001: Limit transports per client (1 producer + 1 consumer max)
    const client = context.clientManager.getClient(socket.id);
    if (client && client.transports.size >= 2) {
      return { success: false, error: Errors.TRANSPORT_LIMIT };
    }

    const cluster = context.roomManager.getRoom(roomId);
    if (!cluster) {
      return { success: false, error: Errors.ROOM_NOT_FOUND };
    }

    const transport = await cluster.createWebRtcTransport(type === "producer");

    // Track transport on client for cleanup
    if (client) {
      client.transports.set(transport.id, type);
    }

    return {
      success: true,
      data: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        iceServers: await getIceServers(),
      },
    };
  },
);

// 2. Connect Transport
const transportConnectHandler = createHandler(
  "transport:connect",
  transportConnectSchema,
  async (payload, _socket, context) => {
    const { roomId, transportId, dtlsParameters } = payload;
    const cluster = context.roomManager.getRoom(roomId);
    const transport = cluster?.getTransport(transportId);

    if (!transport) {
      return { success: false, error: Errors.TRANSPORT_NOT_FOUND };
    }

    await transport.connect({
      dtlsParameters: dtlsParameters as mediasoup.types.DtlsParameters,
    });
    return { success: true };
  },
);

// 3. Produce (Audio) — always on source router
const audioProduceHandler = createHandler(
  "audio:produce",
  audioProduceSchema,
  async (payload, socket, context) => {
    const { roomId, transportId, kind, rtpParameters } = payload;
    const cluster = context.roomManager.getRoom(roomId);
    const transport = cluster?.getTransport(transportId);

    if (!transport) {
      return { success: false, error: Errors.TRANSPORT_NOT_FOUND };
    }

    const producer = await transport.produce({
      kind,
      rtpParameters: rtpParameters as mediasoup.types.RtpParameters,
      appData: { userId: socket.data.user.id },
    });

    // Track producer on client for discovery by new joiners
    const client = context.clientManager.getClient(socket.id);
    if (client) {
      client.producers.set(kind, producer.id);
      client.isSpeaker = true;
      logger.debug(
        { userId: client.userId, producerId: producer.id, kind },
        "Producer tracked on client",
      );
    }

    // Add to active speaker observer
    if (cluster?.audioObserver) {
      await cluster.audioObserver.addProducer({ producerId: producer.id });
    }

    // Register producer in cluster — auto-pipes to distribution routers
    // MUST complete before notifying listeners so piped producers exist
    if (cluster) {
      await cluster.registerProducer(producer);
    }

    const userId = socket.data.user.id;
    const newProducerEvent = { producerId: producer.id, userId, kind: "audio" };

    // Reverse-pipe handling: if this socket is on an EDGE for this room, the
    // speaker's audio lives on this edge but origin & other edges hear silence
    // until we open a reverse pipe. setupReversePipe drives the handshake;
    // origin then broadcasts its own audio:newProducer (with originatingEdgeId
    // tagged) to all edges, so we must NOT also relay this edge-local event
    // cross-instance — that would race with origin's broadcast and try to
    // re-pipe our own audio back to ourselves.
    const isEdgeRoom =
      context.cascadeCoordinator?.isEdgeRoom(roomId) ?? false;

    if (isEdgeRoom && context.cascadeCoordinator && cluster) {
      // Local broadcast first so this edge's listeners don't wait on the
      // reverse-pipe handshake to start consuming the local producer.
      socket.local.to(roomId).emit("audio:newProducer", newProducerEvent);

      // Open the reverse pipe in the background. On failure we log and continue
      // — local listeners can still hear; only cross-instance is silent.
      void context.cascadeCoordinator
        .setupReversePipe(roomId, producer, cluster, userId)
        .then((result) => {
          if (!result) {
            logger.warn(
              { roomId, edgeProducerId: producer.id, userId },
              "Reverse pipe setup failed — cross-instance listeners will be silent for this speaker",
            );
          }
        })
        .catch((err) => {
          logger.error(
            { err, roomId, edgeProducerId: producer.id, userId },
            "Reverse pipe setup threw",
          );
        });
    } else {
      // Origin path (or single-instance/cascade-off): emitToRoom is the
      // cascade-aware combined local + relay broadcast.
      emitToRoom(
        socket,
        roomId,
        "audio:newProducer",
        newProducerEvent,
        context.cascadeRelay,
      );
    }

    producer.on("transportclose", () => {
      // Clean up client tracking
      if (client) {
        client.producers.delete(kind);
        client.isSpeaker = client.producers.size > 0;
      }
      // CQ-LOW-001: Guard against double-close
      if (!producer.closed) producer.close();

      // Tear down the reverse pipe if we opened one. Origin will then close
      // its inbound transport (which closes its producer and cascades
      // audio:producerClosed to all listeners).
      if (isEdgeRoom && context.cascadeCoordinator) {
        context.cascadeCoordinator
          .closeReversePipe(roomId, producer.id)
          .catch((err) =>
            logger.warn(
              { err, roomId, edgeProducerId: producer.id },
              "closeReversePipe failed",
            ),
          );
      }

      // Notify the room (incl. cross-region edges) so listener consumers
      // get cleanup. Without this, edge-region listeners hold dead
      // consumers (no RTP arriving) until full rejoin. Cascade-aware emit.
      emitToRoom(socket, roomId, "audio:producerClosed", {
        producerId: producer.id,
        userId,
      }, context.cascadeRelay);
    });

    return { success: true, data: { id: producer.id } };
  },
);

// 4. Consume — uses cluster to resolve piped producer IDs
const audioConsumeHandler = createHandler(
  "audio:consume",
  audioConsumeSchema,
  async (payload, _socket, context) => {
    const { roomId, transportId, producerId, rtpCapabilities } = payload;
    const cluster = context.roomManager.getRoom(roomId);
    if (!cluster) {
      return { success: false, error: Errors.ROOM_NOT_FOUND };
    }

    // Check if the source producer can be consumed
    if (
      !cluster.canConsume(
        producerId,
        rtpCapabilities as mediasoup.types.RtpCapabilities,
      )
    ) {
      return { success: false, error: Errors.CANNOT_CONSUME };
    }

    // cluster.consume() resolves piped producer ID and creates consumer
    const consumer = await cluster.consume(
      transportId,
      producerId,
      rtpCapabilities as mediasoup.types.RtpCapabilities,
    );

    return {
      success: true,
      data: {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      },
    };
  },
);

// 5. Resume (Audio)
const consumerResumeHandler = createHandler(
  "consumer:resume",
  consumerResumeSchema,
  async (payload, _socket, context) => {
    const { roomId, consumerId } = payload;
    const cluster = context.roomManager.getRoom(roomId);
    if (!cluster) {
      return { success: false, error: Errors.ROOM_NOT_FOUND };
    }

    const consumer = cluster.getConsumer(consumerId);
    if (!consumer) {
      return { success: false, error: Errors.CONSUMER_NOT_FOUND };
    }

    await consumer.resume();
    return { success: true };
  },
);

// 6. Self Mute — pauses producer server-side (stops all downstream consumers)
const selfMuteHandler = createHandler(
  "audio:selfMute",
  selfMuteSchema,
  async (payload, socket, context) => {
    const { roomId, producerId } = payload;
    const cluster = context.roomManager.getRoom(roomId);
    const producer = cluster?.getProducer(producerId);

    if (!producer) {
      return { success: false, error: Errors.PRODUCER_NOT_FOUND };
    }

    // RT-LOW-001: Verify requesting socket owns this producer
    if (producer.appData.userId !== socket.data.user.id) {
      return { success: false, error: Errors.NOT_PRODUCER_OWNER };
    }

    await producer.pause();
    logger.debug(
      { producerId, userId: socket.data.user.id },
      "Producer paused (self-mute)",
    );

    // Notify room so frontend can update UI (cascade-aware)
    emitToRoom(socket, roomId, "seat:userMuted", {
      userId: socket.data.user.id,
      isMuted: true,
      selfMuted: true,
    }, context.cascadeRelay);

    return { success: true };
  },
);

// 7. Self Unmute — resumes producer server-side
const selfUnmuteHandler = createHandler(
  "audio:selfUnmute",
  selfMuteSchema,
  async (payload, socket, context) => {
    const { roomId, producerId } = payload;
    const cluster = context.roomManager.getRoom(roomId);
    const producer = cluster?.getProducer(producerId);

    if (!producer) {
      return { success: false, error: Errors.PRODUCER_NOT_FOUND };
    }

    // RT-LOW-001: Verify requesting socket owns this producer
    if (producer.appData.userId !== socket.data.user.id) {
      return { success: false, error: Errors.NOT_PRODUCER_OWNER };
    }

    await producer.resume();
    logger.debug(
      { producerId, userId: socket.data.user.id },
      "Producer resumed (self-unmute)",
    );

    // Notify room so frontend can update UI (cascade-aware)
    emitToRoom(socket, roomId, "seat:userMuted", {
      userId: socket.data.user.id,
      isMuted: false,
      selfMuted: true,
    }, context.cascadeRelay);

    return { success: true };
  },
);

// ─────────────────────────────────────────────────────────────────
// Export: Register all media handlers on a socket
// ─────────────────────────────────────────────────────────────────

export const mediaHandler = (socket: Socket, context: AppContext) => {
  socket.on("transport:create", transportCreateHandler(socket, context));
  socket.on("transport:connect", transportConnectHandler(socket, context));
  socket.on("audio:produce", audioProduceHandler(socket, context));
  socket.on("audio:consume", audioConsumeHandler(socket, context));
  socket.on("consumer:resume", consumerResumeHandler(socket, context));
  socket.on("audio:selfMute", selfMuteHandler(socket, context));
  socket.on("audio:selfUnmute", selfUnmuteHandler(socket, context));
};
