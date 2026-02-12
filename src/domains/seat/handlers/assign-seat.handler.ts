/**
 * seat:assign - Owner assigns user to specific seat
 */
import { seatAssignSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomOwner } from "@src/domains/seat/seat.owner.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";

export const assignSeatHandler = createHandler(
  "seat:assign",
  seatAssignSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, userId: targetUserId, seatIndex } = payload;

    const ownership = await verifyRoomOwner(roomId, userId, context);
    if (!ownership.allowed) {
      return { success: false, error: ownership.error };
    }

    const targetUserIdStr = String(targetUserId);

    // SEAT-009: Use actual per-room seatCount from state
    const roomState = await context.roomManager.state.get(roomId);
    const seatCount = roomState?.seatCount ?? config.DEFAULT_SEAT_COUNT;

    // Use atomic Redis operation
    const result = await context.seatRepository.assignSeat(
      roomId,
      targetUserIdStr,
      seatIndex,
      seatCount,
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    logger.info(
      { roomId, targetUserId, seatIndex, assignedBy: userId },
      "User assigned to seat",
    );

    // BL-007 FIX: userId-only — frontend looks up user from participants
    socket.to(roomId).emit("seat:updated", {
      seatIndex,
      userId: targetUserId,
      isMuted: false,
    });

    return { success: true };
  },
);
