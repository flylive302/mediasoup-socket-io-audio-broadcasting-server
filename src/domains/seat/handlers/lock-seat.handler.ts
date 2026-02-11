/**
 * seat:lock - Owner/Admin locks a seat (kicks user if occupied)
 */
import { seatLockSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";


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

    // Check if already locked (using Redis)
    const alreadyLocked = await context.seatRepository.isSeatLocked(
      roomId,
      seatIndex,
    );
    if (alreadyLocked) {
      return { success: false, error: Errors.SEAT_ALREADY_LOCKED };
    }

    // Lock the seat (kicks occupant if any)
    const { kicked } = await context.seatRepository.lockSeat(
      roomId,
      seatIndex,
    );

    // If someone was kicked, notify room and close their producer
    if (kicked) {
      socket.nsp.to(roomId).emit("seat:cleared", { seatIndex });

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
            producer.close();
            logger.info(
              { roomId, producerId: audioProducerId, kickedUserId: kicked },
              "Producer closed (seat locked)",
            );
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
    socket.nsp.to(roomId).emit("seat:locked", { seatIndex, isLocked: true });

    return { success: true };
  },
);
