/**
 * seat:unmute - Owner/Admin unmutes user
 */
import { seatMuteSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";


export const unmuteSeatHandler = createHandler(
  "seat:unmute",
  seatMuteSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, userId: targetUserId } = payload;

    const authorization = await verifyRoomManager(roomId, userId, context);
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }

    const targetUserIdStr = String(targetUserId);

    // Find user's seat using Redis
    const seatIndex = await context.seatRepository.getUserSeat(
      roomId,
      targetUserIdStr,
    );

    if (seatIndex === null) {
      return { success: false, error: Errors.USER_NOT_SEATED };
    }

    // Update mute status in Redis
    const success = await context.seatRepository.setMute(
      roomId,
      seatIndex,
      false,
    );
    if (!success) {
      return { success: false, error: Errors.UNMUTE_FAILED };
    }

    logger.info(
      { roomId, targetUserId, seatIndex, unmutedBy: userId },
      "User unmuted",
    );

    // Resume audio on the server side
    const targetClient = context.clientManager
      .getClientsInRoom(roomId)
      .find((c) => String(c.userId) === targetUserIdStr);

    if (targetClient) {
      const audioProducerId = targetClient.producers.get("audio");
      if (audioProducerId) {
        const room = await context.roomManager.getRoom(roomId);
        const producer = room?.getProducer(audioProducerId);
        if (producer) {
          await producer.resume();
          logger.info(
            { roomId, targetUserId, producerId: audioProducerId },
            "Producer resumed (server-side unmute)",
          );
        }
      }
    }

    socket.nsp.to(roomId).emit("seat:userMuted", {
      userId: targetUserId,
      isMuted: false,
    });

    return { success: true };
  },
);
