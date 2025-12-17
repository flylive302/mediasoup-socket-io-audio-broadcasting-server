/**
 * seat:assign - Owner assigns user to specific seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatAssignSchema } from "../seat.requests.js";
import {
  getOrCreateRoomSeats,
  findUserSeat,
  verifyRoomOwner,
} from "../seat.state.js";

export function assignSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const result = seatAssignSchema.safeParse(rawPayload);
    if (!result.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId, userId: targetUserId, seatIndex } = result.data;
    const seats = getOrCreateRoomSeats(roomId);

    const ownership = await verifyRoomOwner(roomId, userId, context);
    if (!ownership.allowed) {
      if (callback) callback({ success: false, error: ownership.error });
      return;
    }

    if (seats.has(seatIndex)) {
      if (callback) callback({ success: false, error: "Seat is already taken" });
      return;
    }

    const targetUserIdStr = String(targetUserId);

    // Remove from existing seat if any
    const existingSeat = findUserSeat(roomId, targetUserIdStr);
    if (existingSeat !== null) {
      seats.delete(existingSeat);
      socket.to(roomId).emit("seat:cleared", { seatIndex: existingSeat });
    }

    seats.set(seatIndex, { userId: targetUserIdStr, muted: false });

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
  };
}
