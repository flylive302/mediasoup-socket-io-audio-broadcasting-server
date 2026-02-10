import type { Socket } from "socket.io";
import type * as mediasoup from "mediasoup";
import type { AppContext } from "../../context.js";
import { logger } from "../../infrastructure/logger.js";
import {
  transportCreateSchema,
  transportConnectSchema,
  audioProduceSchema,
  audioConsumeSchema,
  consumerResumeSchema,
  selfMuteSchema,
} from "../../socket/schemas.js";

export const mediaHandler = (socket: Socket, context: AppContext) => {
  const { roomManager, clientManager } = context;

  // 1. Create Transport
  socket.on("transport:create", async (rawPayload: unknown, callback) => {
    // Validate
    const payloadResult = transportCreateSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback)
        callback({
          error: "Invalid payload",
          details: payloadResult.error.format(),
        });
      return;
    }
    const { type, roomId } = payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    if (!cluster) {
      if (callback) callback({ error: "Room not found" });
      return;
    }

    try {
      const transport = await cluster.createWebRtcTransport(
        type === "producer",
      );

      // Track transport on client for cleanup
      const client = clientManager.getClient(socket.id);
      if (client) {
        client.transports.set(transport.id, type);
      }

      if (callback) {
        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      }
    } catch (error) {
      logger.error({ error }, "Transport creation failed");
      if (callback) callback({ error: "Server error" });
    }
  });

  // 2. Connect Transport
  socket.on("transport:connect", async (rawPayload: unknown, callback) => {
    const payloadResult = transportConnectSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, transportId, dtlsParameters } = payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    const transport = cluster?.getTransport(transportId);

    if (!transport) {
      if (callback) callback({ error: "Transport not found" });
      return;
    }

    try {
      await transport.connect({
        dtlsParameters: dtlsParameters as mediasoup.types.DtlsParameters,
      });
      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error }, "Transport connect failed");
      if (callback) callback({ error: "Connect failed" });
    }
  });

  // 3. Produce (Audio) — always on source router
  socket.on("audio:produce", async (rawPayload: unknown, callback) => {
    const payloadResult = audioProduceSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, transportId, kind, rtpParameters } = payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    const transport = cluster?.getTransport(transportId);

    if (!transport) {
      if (callback) callback({ error: "Transport not found" });
      return;
    }

    try {
      const producer = await transport.produce({
        kind,
        rtpParameters: rtpParameters as mediasoup.types.RtpParameters,
        appData: { userId: socket.data.user.id },
      });

      // Track producer on client for discovery by new joiners
      const client = clientManager.getClient(socket.id);
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
        producer.close();
      });

      if (callback) callback({ id: producer.id });
    } catch (error) {
      logger.error({ error }, "Produce failed");
      if (callback) callback({ error: "Produce failed" });
    }
  });

  // 4. Consume — uses cluster to resolve piped producer IDs
  socket.on("audio:consume", async (rawPayload: unknown, callback) => {
    const payloadResult = audioConsumeSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, transportId, producerId, rtpCapabilities } =
      payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    if (!cluster) {
      if (callback) callback({ error: "Room not found" });
      return;
    }

    // Check if the source producer can be consumed
    if (!cluster.canConsume(producerId, rtpCapabilities as mediasoup.types.RtpCapabilities)) {
      if (callback) callback({ error: "Cannot consume" });
      return;
    }

    try {
      // cluster.consume() resolves piped producer ID and creates consumer
      const consumer = await cluster.consume(
        transportId,
        producerId,
        rtpCapabilities as mediasoup.types.RtpCapabilities,
      );

      if (callback) {
        callback({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      }
    } catch (error) {
      logger.error({ error }, "Consume failed");
      if (callback) callback({ error: "Consume failed" });
    }
  });

  // 5. Resume (Audio)
  socket.on("consumer:resume", async (rawPayload: unknown, callback) => {
    const payloadResult = consumerResumeSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, consumerId } = payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    if (!cluster) {
      if (callback) callback({ error: "Room not found" });
      return;
    }

    const consumer = cluster.getConsumer(consumerId);
    if (!consumer) {
      if (callback) callback({ error: "Consumer not found" });
      return;
    }

    try {
      // Only resume if the source producer is an active speaker
      // (active speaker forwarding optimization)
      const sourceProducerId = consumer.appData.sourceProducerId as string | undefined;
      if (sourceProducerId && !cluster.isActiveSpeaker(sourceProducerId)) {
        // Don't resume — this speaker is not currently active
        // The consumer will be auto-resumed when the speaker becomes active
        if (callback) callback({ success: true, deferred: true });
        return;
      }

      await consumer.resume();
      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error }, "Resume failed");
      if (callback) callback({ error: "Resume failed" });
    }
  });

  // 6. Self Mute — pauses producer server-side (stops all downstream consumers)
  socket.on("audio:selfMute", async (rawPayload: unknown, callback) => {
    const payloadResult = selfMuteSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, producerId } = payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    const producer = cluster?.getProducer(producerId);

    if (!producer) {
      if (callback) callback({ error: "Producer not found" });
      return;
    }

    try {
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

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error }, "Self-mute failed");
      if (callback) callback({ error: "Mute failed" });
    }
  });

  // 7. Self Unmute — resumes producer server-side
  socket.on("audio:selfUnmute", async (rawPayload: unknown, callback) => {
    const payloadResult = selfMuteSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, producerId } = payloadResult.data;

    const cluster = await roomManager.getRoom(roomId);
    const producer = cluster?.getProducer(producerId);

    if (!producer) {
      if (callback) callback({ error: "Producer not found" });
      return;
    }

    try {
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

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error }, "Self-unmute failed");
      if (callback) callback({ error: "Unmute failed" });
    }
  });
};
