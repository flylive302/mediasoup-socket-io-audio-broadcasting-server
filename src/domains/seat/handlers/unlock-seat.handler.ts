/**
 * seat:unlock - Owner/Admin unlocks a seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../../context.js";
import { logger } from "../../../infrastructure/logger.js";
import { seatLockSchema } from "../seat.requests.js";
import { verifyRoomManager } from "../seat.owner.js";

export function unlockSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    try {
      const parseResult = seatLockSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, seatIndex } = parseResult.data;

      const authorization = await verifyRoomManager(roomId, userId, context);
      if (!authorization.allowed) {
        if (callback) callback({ success: false, error: authorization.error });
        return;
      }

      // Check if not locked (using Redis)
      const isLocked = await context.seatRepository.isSeatLocked(
        roomId,
        seatIndex,
      );
      if (!isLocked) {
        if (callback) callback({ success: false, error: "Seat is not locked" });
        return;
      }

      // Unlock the seat (using Redis)
      await context.seatRepository.unlockSeat(roomId, seatIndex);

      logger.info({ roomId, seatIndex, unlockedBy: userId }, "Seat unlocked");

      // Broadcast to all including sender
      const unlockEvent = { seatIndex, isLocked: false };
      socket.to(roomId).emit("seat:locked", unlockEvent);
      socket.emit("seat:locked", unlockEvent);

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error, userId }, "seat:unlock handler exception");
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
