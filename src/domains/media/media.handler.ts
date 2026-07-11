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
import { retryAsync } from "@src/shared/retry.js";
import { Errors } from "@src/shared/errors.js";
import { getIceServers } from "@src/config/iceServers.js";
import type { Socket } from "socket.io";
import type { ClientData } from "@src/client/clientManager.js";

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
    // MUST complete before notifying listeners so piped producers exist.
    // All-or-nothing: registerProducer throws when piping fails post-retry;
    // close the producer and fail the ack so the client re-produces, instead
    // of leaving a half-piped speaker some listeners can't hear.
    if (cluster) {
      try {
        await cluster.registerProducer(producer);
      } catch (err) {
        logger.error(
          { err, roomId, producerId: producer.id },
          "audio:produce failed — could not pipe producer to distribution routers",
        );
        producer.close();
        if (client) {
          client.producers.delete(kind);
          client.isSpeaker = false;
        }
        return { success: false, error: Errors.INTERNAL_ERROR };
      }
    }

    // realtime-09: a new speaker changes the broadcast mix topology. No-op unless
    // this Room is publishing HLS; otherwise re-syncs the mixer + restarts FFmpeg.
    context.broadcastController.onSpeakerChange(roomId);

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

      // Open the reverse pipe in the background, retrying with backoff —
      // a one-shot failure used to leave this speaker permanently silent to
      // every other instance (2026-07-10 audio review). Still fire-and-forget
      // so local listeners never wait on the cross-instance handshake.
      const coordinator = context.cascadeCoordinator;
      void retryAsync(
        () => coordinator.setupReversePipe(roomId, producer, cluster, userId),
        { attempts: 3, baseDelayMs: 500, accept: (r) => Boolean(r) },
      )
        .then((result) => {
          if (!result) {
            logger.warn(
              { roomId, edgeProducerId: producer.id, userId },
              "Reverse pipe setup failed after retries — cross-instance listeners will be silent for this speaker",
            );
          }
        })
        .catch((err) => {
          logger.error(
            { err, roomId, edgeProducerId: producer.id, userId },
            "Reverse pipe setup threw after retries",
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

    reactOnProducerClose(producer, client, kind, isEdgeRoom, socket, roomId, context);

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

    // Check if the source producer can be consumed on THIS listener's
    // distribution router (not router[0] — piped sets can diverge on failure)
    if (
      !cluster.canConsume(
        transportId,
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

    // realtime-09: in broadcast mode the producer must stay LIVE so its HLS mix
    // input never dies — a paused (RTP-less) producer freezes the sample-synchronous
    // amix for ALL Listeners. The client mutes the mic locally; Opus DTX keeps the
    // stream audible-silent. Interactive mode keeps the server-side pause as before.
    if (!context.broadcastController.isBroadcasting(roomId)) {
      await producer.pause();
    }
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

    // realtime-09: reconcile the mix (no-op in broadcast since the producer stays
    // resumed; matters if a pause happened just before a flip).
    context.broadcastController.onSpeakerChange(roomId);

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

    // Always resume: a no-op when already live (broadcast self-mute never paused),
    // and it recovers a producer that was paused (self-muted) just before a flip
    // so the speaker rejoins the broadcast mix on unmute.
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

    // realtime-09: a resumed producer (re)enters the broadcast mix.
    context.broadcastController.onSpeakerChange(roomId);

    // Reverse-pipe self-heal (long-mute audio loss): on an edge, the reverse
    // pipe to origin is built once at audio:produce and has no liveness
    // monitor. If it died or never finalized during a long mute, resume alone
    // leaves cross-instance listeners silent. setupReversePipe is idempotent
    // (healthy cached entry → no-op), so re-kick it fire-and-forget here.
    const coordinator = context.cascadeCoordinator;
    if (coordinator?.isEdgeRoom(roomId) && cluster) {
      void retryAsync(
        () => coordinator.setupReversePipe(roomId, producer, cluster, socket.data.user.id),
        { attempts: 3, baseDelayMs: 500, accept: (r) => Boolean(r) },
      )
        .then((result) => {
          if (!result) {
            logger.warn(
              { roomId, producerId, userId: socket.data.user.id },
              "selfUnmute reverse-pipe self-heal failed after retries — cross-instance listeners may stay silent",
            );
          }
        })
        .catch((err) => {
          logger.error(
            { err, roomId, producerId },
            "selfUnmute reverse-pipe self-heal threw after retries",
          );
        });
    }

    return { success: true };
  },
);

// ─────────────────────────────────────────────────────────────────
// REACT-stage helpers
// ─────────────────────────────────────────────────────────────────

export function reactOnProducerClose(
  producer: mediasoup.types.Producer,
  client: ClientData | undefined,
  kind: string,
  isEdgeRoom: boolean,
  socket: Socket,
  roomId: string,
  context: AppContext,
): void {
  producer.on("transportclose", () => {
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
    // get cleanup. Cascade-aware emit.
    emitToRoom(socket, roomId, "audio:producerClosed", {
      producerId: producer.id,
      userId: socket.data.user.id as number,
    }, context.cascadeRelay);

    // realtime-09: speaker gone → drop it from the broadcast mix (restart FFmpeg
    // on the reduced set; a dead RTP input would otherwise freeze amix).
    context.broadcastController.onSpeakerChange(roomId);
  });
}

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
