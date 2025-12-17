/**
 * seat:unlock - Owner unlocks a seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatLockSchema } from "../seat.requests.js";
import {
  isSeatLocked,
  unlockSeat,
  verifyRoomOwner,
} from "../seat.state.js";

export function unlockSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const result = seatLockSchema.safeParse(rawPayload);
    if (!result.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId, seatIndex } = result.data;

    const ownership = await verifyRoomOwner(roomId, userId, context);
    if (!ownership.allowed) {
      if (callback) callback({ success: false, error: ownership.error });
      return;
    }

    // Check if not locked
    if (!isSeatLocked(roomId, seatIndex)) {
      if (callback) callback({ success: false, error: "Seat is not locked" });
      return;
    }

    // Unlock the seat
    unlockSeat(roomId, seatIndex);

    logger.info({ roomId, seatIndex, unlockedBy: userId }, "Seat unlocked");

    // Broadcast to all including sender
    const unlockEvent = { seatIndex, isLocked: false };
    socket.to(roomId).emit("seat:locked", unlockEvent);
    socket.emit("seat:locked", unlockEvent);

    if (callback) callback({ success: true });
  };
}
