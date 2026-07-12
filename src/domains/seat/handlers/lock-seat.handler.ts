/**
 * seat:lock - Owner/Admin locks a seat (kicks user if occupied)
 */
import { seatLockSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { closeAllUserProducers } from "@src/shared/producer-cleanup.js";
import { releaseMusicPlayerForUser } from "@src/domains/audio-player/audio-player.handler.js";

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

    // If someone was kicked, notify room and close ALL their producers
    if (kicked) {
      broadcastToRoom(
        socket.nsp,
        roomId,
        "seat:cleared",
        { seatIndex, userId: Number(kicked) },
        context.cascadeRelay,
      );

      const kickedUserId = Number(kicked);

      // Server-side producer close — don't rely on frontend.
      // dj-talk-over/02: close EVERY producer the kicked user holds (mic
      // AND music) — a kicked-from-seat DJ's music must not keep flowing.
      const kickedClient = context.clientManager
        .getClientsInRoom(roomId)
        .find((c) => String(c.userId) === String(kicked));

      if (kickedClient) {
        const room = context.roomManager.getRoom(roomId);
        closeAllUserProducers(kickedClient, kickedUserId, roomId, room, {
          reason: "seat-lock",
        });
      }

      // dj-talk-over/02: release the room's music mutex + broadcast stop if
      // the kicked user held it — a no-op otherwise (kicking a non-DJ must
      // never touch the room's music).
      await releaseMusicPlayerForUser(
        context.redis,
        context.io,
        roomId,
        kickedUserId,
        context.cascadeRelay,
      );

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
