/**
 * seat:leave - User leaves their seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../../context.js";
import { logger } from "../../../infrastructure/logger.js";
import { seatLeaveSchema } from "../seat.requests.js";

export function leaveSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const parseResult = seatLeaveSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId } = parseResult.data;

    try {
      const result = await context.seatRepository.leaveSeat(roomId, userId);

      if (!result.success) {
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      logger.info(
        { roomId, userId, seatIndex: result.seatIndex },
        "User left seat",
      );

      // Broadcast to room
      socket.to(roomId).emit("seat:cleared", { seatIndex: result.seatIndex });

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error, roomId, userId }, "Failed to leave seat");
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
