/**
 * seat:assign - Owner assigns user to specific seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../../context.js";
import { logger } from "../../../infrastructure/logger.js";
import { seatAssignSchema } from "../seat.requests.js";
import { verifyRoomOwner } from "../seat.owner.js";
import { config } from "../../../config/index.js";

export function assignSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    try {
      const parseResult = seatAssignSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId, seatIndex } = parseResult.data;

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      const targetUserIdStr = String(targetUserId);

      // Use atomic Redis operation
      const result = await context.seatRepository.assignSeat(
        roomId,
        targetUserIdStr,
        seatIndex,
        config.DEFAULT_SEAT_COUNT,
      );

      if (!result.success) {
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      logger.info(
        { roomId, targetUserId, seatIndex, assignedBy: userId },
        "User assigned to seat",
      );

      // Broadcast seat update - frontend will look up user info from participants
      socket.to(roomId).emit("seat:updated", {
        seatIndex,
        user: { id: targetUserId },
        isMuted: false,
      });

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error, userId }, "seat:assign handler exception");
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
