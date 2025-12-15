import type { Socket } from "socket.io";
import type * as mediasoup from "mediasoup";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import {
  transportCreateSchema,
  transportConnectSchema,
  audioProduceSchema,
  audioConsumeSchema,
  consumerResumeSchema,
} from "../schemas.js";

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

    const routerMgr = await roomManager.getRoom(roomId);
    if (!routerMgr) {
      if (callback) callback({ error: "Room not found" });
      return;
    }

    try {
      const transport = await routerMgr.createWebRtcTransport(
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

    const routerMgr = await roomManager.getRoom(roomId);
    const transport = routerMgr?.getTransport(transportId);

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

  // 3. Produce (Audio)
  socket.on("audio:produce", async (rawPayload: unknown, callback) => {
    const payloadResult = audioProduceSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, transportId, kind, rtpParameters } = payloadResult.data;

    const routerMgr = await roomManager.getRoom(roomId);
    const transport = routerMgr?.getTransport(transportId);

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
      if (routerMgr?.audioObserver) {
        await routerMgr.audioObserver.addProducer({ producerId: producer.id });
      }

      // Notify room members causing them to consume
      socket.to(roomId).emit("audio:newProducer", {
        producerId: producer.id,
        userId: socket.data.user.id,
        kind: "audio",
      });

      // Register producer in router manager for lookups (e.g. for mute)
      if (routerMgr) {
        routerMgr.registerProducer(producer);
      }

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

  // 4. Consume
  socket.on("audio:consume", async (rawPayload: unknown, callback) => {
    const payloadResult = audioConsumeSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (callback) callback({ error: "Invalid payload" });
      return;
    }
    const { roomId, transportId, producerId, rtpCapabilities } =
      payloadResult.data;

    const routerMgr = await roomManager.getRoom(roomId);
    if (!routerMgr || !routerMgr.router) {
      if (callback) callback({ error: "Room not found" });
      return;
    }

    const transport = routerMgr.getTransport(transportId);
    if (!transport) {
      if (callback) callback({ error: "Transport not found" });
      return;
    }

    // Ensure we can consume
    if (!routerMgr.router.canConsume({ producerId, rtpCapabilities })) {
      if (callback) callback({ error: "Cannot consume" });
      return;
    }

    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // Start paused recommended
      });

      consumer.on("transportclose", () => consumer.close());
      consumer.on("producerclose", () => consumer.close());

      // Register consumer for resume capability
      if (routerMgr) {
        routerMgr.registerConsumer(consumer);
      }

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

    const routerMgr = await roomManager.getRoom(roomId);
    if (!routerMgr) {
      if (callback) callback({ error: "Room not found" });
      return;
    }

    const consumer = routerMgr.getConsumer(consumerId);
    if (!consumer) {
      if (callback) callback({ error: "Consumer not found" });
      return;
    }

    try {
      await consumer.resume();
      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error }, "Resume failed");
      if (callback) callback({ error: "Resume failed" });
    }
  });
};
