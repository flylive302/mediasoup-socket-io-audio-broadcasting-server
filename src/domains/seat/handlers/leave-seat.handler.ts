/**
 * seat:leave - User leaves their seat
 */
import { seatLeaveSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { logger } from "@src/infrastructure/logger.js";

export const leaveSeatHandler = createHandler(
  "seat:leave",
  seatLeaveSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId } = payload;

    const result = await context.seatRepository.leaveSeat(roomId, userId);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    logger.info(
      { roomId, userId, seatIndex: result.seatIndex },
      "User left seat",
    );

    // Broadcast to room
    socket.to(roomId).emit("seat:cleared", { seatIndex: result.seatIndex });

    return { success: true };
  },
);
