/**
 * seat:lock - Owner locks a seat (kicks user if occupied)
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatLockSchema } from "../seat.requests.js";
import {
  getOrCreateRoomSeats,
  isSeatLocked,
  lockSeat,
  verifyRoomOwner,
} from "../seat.state.js";

export function lockSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const startTime = Date.now();
    logger.info({ userId, payload: rawPayload }, "seat:lock received");

    try {
      const result = seatLockSchema.safeParse(rawPayload);
      if (!result.success) {
        logger.warn({ userId, error: result.error }, "seat:lock invalid payload");
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, seatIndex } = result.data;
      logger.info({ userId, roomId, seatIndex }, "seat:lock verifying ownership");

      const ownership = await verifyRoomOwner(roomId, userId, context);
      const verifyTime = Date.now() - startTime;
      logger.info(
        {
          userId,
          roomId,
          seatIndex,
          allowed: ownership.allowed,
          verifyTimeMs: verifyTime,
        },
        "seat:lock ownership verified",
      );

      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      // Check if already locked
      if (isSeatLocked(roomId, seatIndex)) {
        if (callback) callback({ success: false, error: "Seat is already locked" });
        return;
      }

      const seats = getOrCreateRoomSeats(roomId);
      const existingSeat = seats.get(seatIndex);

      // If someone is on this seat, kick them
      if (existingSeat) {
        seats.delete(seatIndex);
        socket.to(roomId).emit("seat:cleared", { seatIndex });
        socket.emit("seat:cleared", { seatIndex });

        logger.info(
          {
            roomId,
            userId: existingSeat.userId,
            seatIndex,
            lockedBy: userId,
          },
          "User kicked from seat due to lock",
        );
      }

      // Lock the seat
      lockSeat(roomId, seatIndex);

      logger.info({ roomId, seatIndex, lockedBy: userId }, "Seat locked");

      // Broadcast to all including sender
      const lockEvent = { seatIndex, isLocked: true };
      socket.to(roomId).emit("seat:locked", lockEvent);
      socket.emit("seat:locked", lockEvent);

      const totalTime = Date.now() - startTime;
      logger.info(
        { userId, roomId, seatIndex, totalTimeMs: totalTime },
        "seat:lock success",
      );

      if (callback) callback({ success: true });
    } catch (error) {
      const totalTime = Date.now() - startTime;
      logger.error(
        {
          error,
          userId,
          totalTimeMs: totalTime,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "seat:lock handler exception",
      );
      if (callback) callback({ success: false, error: "Internal server error" });
    }
  };
}
