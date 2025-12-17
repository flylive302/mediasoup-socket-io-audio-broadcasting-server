/**
 * seat:leave - User leaves their seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatLeaveSchema } from "../seat.requests.js";
import { getOrCreateRoomSeats, findUserSeat } from "../seat.state.js";

export function leaveSeatHandler(socket: Socket, _context: AppContext) {
  const userId = String(socket.data.user.id);

  return (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const result = seatLeaveSchema.safeParse(rawPayload);
    if (!result.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId } = result.data;
    const seatIndex = findUserSeat(roomId, userId);

    if (seatIndex === null) {
      if (callback) callback({ success: false, error: "You are not seated" });
      return;
    }

    const seats = getOrCreateRoomSeats(roomId);
    seats.delete(seatIndex);

    logger.info({ roomId, userId, seatIndex }, "User left seat");

    // Broadcast to room
    socket.to(roomId).emit("seat:cleared", { seatIndex });

    if (callback) callback({ success: true });
  };
}
