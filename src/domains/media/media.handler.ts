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
      return { success: false, error: "Transport limit reached" };
    }

    const cluster = await context.roomManager.getRoom(roomId);
    if (!cluster) {
      return { success: false, error: "Room not found" };
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
    const cluster = await context.roomManager.getRoom(roomId);
    const transport = cluster?.getTransport(transportId);

    if (!transport) {
      return { success: false, error: "Transport not found" };
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
    const cluster = await context.roomManager.getRoom(roomId);
    const transport = cluster?.getTransport(transportId);

    if (!transport) {
      return { success: false, error: "Transport not found" };
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

    // Notify room members causing them to consume
    // (after piping is complete so distribution routers have the producer)
    socket.to(roomId).emit("audio:newProducer", {
      producerId: producer.id,
      userId: socket.data.user.id,
      kind: "audio",
    });

    producer.on("transportclose", () => {
      // Clean up client tracking
      if (client) {
        client.producers.delete(kind);
        client.isSpeaker = client.producers.size > 0;
      }
      // CQ-LOW-001: Guard against double-close
      if (!producer.closed) producer.close();
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
    const cluster = await context.roomManager.getRoom(roomId);
    if (!cluster) {
      return { success: false, error: "Room not found" };
    }

    // Check if the source producer can be consumed
    if (
      !cluster.canConsume(
        producerId,
        rtpCapabilities as mediasoup.types.RtpCapabilities,
      )
    ) {
      return { success: false, error: "Cannot consume" };
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
    const cluster = await context.roomManager.getRoom(roomId);
    if (!cluster) {
      return { success: false, error: "Room not found" };
    }

    const consumer = cluster.getConsumer(consumerId);
    if (!consumer) {
      return { success: false, error: "Consumer not found" };
    }

    // Only resume if the source producer is an active speaker
    // (active speaker forwarding optimization)
    const sourceProducerId = consumer.appData.sourceProducerId as
      | string
      | undefined;
    if (sourceProducerId && !cluster.isActiveSpeaker(sourceProducerId)) {
      // Don't resume — this speaker is not currently active
      // The consumer will be auto-resumed when the speaker becomes active
      return { success: true, data: { deferred: true } };
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
    const cluster = await context.roomManager.getRoom(roomId);
    const producer = cluster?.getProducer(producerId);

    if (!producer) {
      return { success: false, error: "Producer not found" };
    }

    // RT-LOW-001: Verify requesting socket owns this producer
    if (producer.appData.userId !== socket.data.user.id) {
      return { success: false, error: "Not your producer" };
    }

    await producer.pause();
    logger.debug(
      { producerId, userId: socket.data.user.id },
      "Producer paused (self-mute)",
    );

    // Notify room so frontend can update UI
    socket.to(roomId).emit("seat:userMuted", {
      userId: socket.data.user.id,
      isMuted: true,
      selfMuted: true,
    });

    return { success: true };
  },
);

// 7. Self Unmute — resumes producer server-side
const selfUnmuteHandler = createHandler(
  "audio:selfUnmute",
  selfMuteSchema,
  async (payload, socket, context) => {
    const { roomId, producerId } = payload;
    const cluster = await context.roomManager.getRoom(roomId);
    const producer = cluster?.getProducer(producerId);

    if (!producer) {
      return { success: false, error: "Producer not found" };
    }

    // RT-LOW-001: Verify requesting socket owns this producer
    if (producer.appData.userId !== socket.data.user.id) {
      return { success: false, error: "Not your producer" };
    }

    await producer.resume();
    logger.debug(
      { producerId, userId: socket.data.user.id },
      "Producer resumed (self-unmute)",
    );

    // Notify room so frontend can update UI
    socket.to(roomId).emit("seat:userMuted", {
      userId: socket.data.user.id,
      isMuted: false,
      selfMuted: true,
    });

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
