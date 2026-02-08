/**
 * seat:mute - Owner/Admin mutes user
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../../context.js";
import { logger } from "../../../infrastructure/logger.js";
import { seatMuteSchema } from "../seat.requests.js";
import { verifyRoomManager } from "../seat.owner.js";

export function muteSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    try {
      const parseResult = seatMuteSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId } = parseResult.data;

      const authorization = await verifyRoomManager(roomId, userId, context);
      if (!authorization.allowed) {
        if (callback) callback({ success: false, error: authorization.error });
        return;
      }

      const targetUserIdStr = String(targetUserId);

      // Find user's seat using Redis
      const seatIndex = await context.seatRepository.getUserSeat(
        roomId,
        targetUserIdStr,
      );

      if (seatIndex === null) {
        if (callback) callback({ success: false, error: "User is not seated" });
        return;
      }

      // Update mute status in Redis
      const success = await context.seatRepository.setMute(
        roomId,
        seatIndex,
        true,
      );
      if (!success) {
        if (callback)
          callback({ success: false, error: "Failed to mute user" });
        return;
      }

      logger.info(
        { roomId, targetUserId, seatIndex, mutedBy: userId },
        "User muted",
      );

      // Enforce silence on the server side by pausing the producer
      const targetClient = context.clientManager
        .getClientsInRoom(roomId)
        .find((c) => String(c.userId) === targetUserIdStr);

      if (targetClient) {
        const audioProducerId = targetClient.producers.get("audio");
        if (audioProducerId) {
          const room = await context.roomManager.getRoom(roomId);
          const producer = room?.getProducer(audioProducerId);
          if (producer) {
            await producer.pause();
            logger.info(
              { roomId, targetUserId, producerId: audioProducerId },
              "Producer paused (server-side mute)",
            );
          }
        }
      }

      socket.to(roomId).emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: true,
      });
      socket.emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: true,
      });

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error, userId }, "seat:mute handler exception");
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
