/**
 * seat:take - User takes an available seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatTakeSchema } from "../seat.requests.js";
import {
  getOrCreateRoomSeats,
  findUserSeat,
  isSeatLocked,
} from "../seat.state.js";

export function takeSeatHandler(socket: Socket, _context: AppContext) {
  const userId = String(socket.data.user.id);

  return (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const result = seatTakeSchema.safeParse(rawPayload);
    if (!result.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId, seatIndex } = result.data;
    const seats = getOrCreateRoomSeats(roomId);

    // Check if seat is locked
    if (isSeatLocked(roomId, seatIndex)) {
      if (callback) callback({ success: false, error: "Seat is locked" });
      return;
    }

    // Check if seat is already taken
    if (seats.has(seatIndex)) {
      if (callback) callback({ success: false, error: "Seat is already taken" });
      return;
    }

    // Check if user is already in another seat
    const existingSeat = findUserSeat(roomId, userId);
    if (existingSeat !== null) {
      // Remove from existing seat first
      seats.delete(existingSeat);
      socket.to(roomId).emit("seat:cleared", { seatIndex: existingSeat });
    }

    // Assign user to seat
    seats.set(seatIndex, { userId, muted: false });

    logger.info({ roomId, userId, seatIndex }, "User took seat");

    // Broadcast to room
    const user = socket.data.user;
    const seatUpdate = {
      seatIndex,
      user: {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
      },
      isMuted: false,
    };

    socket.to(roomId).emit("seat:updated", seatUpdate);

    if (callback) callback({ success: true });
  };
}
