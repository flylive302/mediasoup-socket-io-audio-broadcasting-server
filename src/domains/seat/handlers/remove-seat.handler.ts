/**
 * seat:remove - Owner removes user from seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../../context.js";
import { logger } from "../../../infrastructure/logger.js";
import { seatRemoveSchema } from "../seat.requests.js";
import { verifyRoomOwner } from "../seat.owner.js";

export function removeSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    try {
      const parseResult = seatRemoveSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId } = parseResult.data;

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      const targetUserIdStr = String(targetUserId);

      // Use Redis operation
      const result = await context.seatRepository.removeSeat(
        roomId,
        targetUserIdStr,
      );

      if (!result.success) {
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      logger.info(
        {
          roomId,
          targetUserId,
          seatIndex: result.seatIndex,
          removedBy: userId,
        },
        "User removed from seat",
      );

      socket.to(roomId).emit("seat:cleared", { seatIndex: result.seatIndex });

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error, userId }, "seat:remove handler exception");
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
