/**
 * seat:remove - Owner removes user from their seat
 */
import { seatRemoveSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomOwner } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";

export const removeSeatHandler = createHandler(
  "seat:remove",
  seatRemoveSchema,
  async (payload, socket, context) => {
    const requesterId = String(socket.data.user.id);
    const { roomId, userId: targetUserId } = payload;

    const ownership = await verifyRoomOwner(roomId, requesterId, context);
    if (!ownership.allowed) {
      return { success: false, error: ownership.error };
    }

    const targetUserIdStr = String(targetUserId);
    const result = await context.seatRepository.removeSeat(roomId, targetUserIdStr);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    logger.info(
      { roomId, targetUserId, seatIndex: result.seatIndex, removedBy: requesterId },
      "User removed from seat",
    );

    // Broadcast to room
    socket.to(roomId).emit("seat:cleared", { seatIndex: result.seatIndex });

    return { success: true };
  },
);
