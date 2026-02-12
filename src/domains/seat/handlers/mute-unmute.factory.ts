/**
 * SEAT-010: Shared factory for mute/unmute handlers to eliminate code duplication.
 * Both handlers share identical logic — only the mute value, producer action,
 * error constant, and log message differ.
 */
import { seatMuteSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";

interface MuteConfig {
  event: "seat:mute" | "seat:unmute";
  muted: boolean;
  failError: string;
  producerAction: "pause" | "resume";
  logAction: string;
  producerLogAction: string;
}

export function createMuteHandler(config: MuteConfig) {
  return createHandler(
    config.event,
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
        config.muted,
      );
      if (!success) {
        return { success: false, error: config.failError };
      }

      logger.info(
        { roomId, targetUserId, seatIndex, [`${config.logAction}By`]: userId },
        `User ${config.logAction}`,
      );

      // Server-side producer pause/resume
      const targetClient = context.clientManager
        .getClientsInRoom(roomId)
        .find((c) => String(c.userId) === targetUserIdStr);

      if (targetClient) {
        const audioProducerId = targetClient.producers.get("audio");
        if (audioProducerId) {
          const room = context.roomManager.getRoom(roomId);
          const producer = room?.getProducer(audioProducerId);
          if (producer) {
            await producer[config.producerAction]();
            logger.info(
              { roomId, targetUserId, producerId: audioProducerId },
              `Producer ${config.producerLogAction}`,
            );
          }
        }
      }

      socket.nsp.to(roomId).emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: config.muted,
      });

      return { success: true };
    },
  );
}
