/**
 * seat:lock - Owner/Admin locks a seat (kicks user if occupied)
 */
import { seatLockSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";



export const lockSeatHandler = createHandler(
  "seat:lock",
  seatLockSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, seatIndex } = payload;

    const authorization = await verifyRoomManager(roomId, userId, context);
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }

    // SEAT-001 FIX: Lock is now fully atomic — no separate isSeatLocked pre-check
    const lockResult = await context.seatRepository.lockSeat(
      roomId,
      seatIndex,
    );

    if (!lockResult.success) {
      return { success: false, error: lockResult.error };
    }

    const kicked = lockResult.kicked;

    // If someone was kicked, notify room and close their producer
    if (kicked) {
      broadcastToRoom(
        socket.nsp,
        roomId,
        "seat:cleared",
        { seatIndex, userId: Number(kicked) },
        context.cascadeRelay,
      );

      // Server-side producer close — don't rely on frontend
      const kickedClient = context.clientManager
        .getClientsInRoom(roomId)
        .find((c) => String(c.userId) === String(kicked));

      if (kickedClient) {
        const audioProducerId = kickedClient.producers.get("audio");
        if (audioProducerId) {
          const room = context.roomManager.getRoom(roomId);
          const producer = room?.getProducer(audioProducerId);
          if (producer && !producer.closed) {
            // F-45: verify the producer still belongs to the kicked user before
            // closing. A rapid disconnect→reconnect→produce (or mute/unmute)
            // can replace the tracked producer id; without this guard a brand
            // new producer the user just created post-reconnect could be closed.
            if (producer.appData.userId === Number(kicked)) {
              producer.close();
              logger.info(
                { roomId, producerId: audioProducerId, kickedUserId: kicked },
                "Producer closed (seat locked)",
              );
            } else {
              logger.warn(
                {
                  roomId,
                  producerId: audioProducerId,
                  kickedUserId: kicked,
                  producerUserId: producer.appData.userId,
                },
                "Skipped producer close on seat lock — producer no longer owned by kicked user (F-45)",
              );
            }
          }
          kickedClient.producers.delete("audio");
          kickedClient.isSpeaker = kickedClient.producers.size > 0;
        }
      }

      logger.info(
        { roomId, userId: kicked, seatIndex, lockedBy: userId },
        "User kicked from seat due to lock",
      );
    }

    logger.info({ roomId, seatIndex, lockedBy: userId }, "Seat locked");

    // Broadcast to all including sender
    broadcastToRoom(socket.nsp, roomId, "seat:locked", { seatIndex, isLocked: true }, context.cascadeRelay);

    return { success: true };
  },
);
