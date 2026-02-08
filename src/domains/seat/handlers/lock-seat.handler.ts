/**
 * seat:lock - Owner/Admin locks a seat (kicks user if occupied)
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../../context.js";
import { logger } from "../../../infrastructure/logger.js";
import { seatLockSchema } from "../seat.requests.js";
import { verifyRoomManager } from "../seat.owner.js";

export function lockSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const startTime = Date.now();
    logger.info({ userId, payload: rawPayload }, "seat:lock received");

    try {
      const parseResult = seatLockSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        logger.warn(
          { userId, error: parseResult.error },
          "seat:lock invalid payload",
        );
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, seatIndex } = parseResult.data;
      logger.info(
        { userId, roomId, seatIndex },
        "seat:lock verifying manager permissions",
      );

      const authorization = await verifyRoomManager(roomId, userId, context);
      const verifyTime = Date.now() - startTime;
      logger.info(
        {
          userId,
          roomId,
          seatIndex,
          allowed: authorization.allowed,
          verifyTimeMs: verifyTime,
        },
        "seat:lock authorization verified",
      );

      if (!authorization.allowed) {
        if (callback) callback({ success: false, error: authorization.error });
        return;
      }

      // Check if already locked (using Redis)
      const alreadyLocked = await context.seatRepository.isSeatLocked(
        roomId,
        seatIndex,
      );
      if (alreadyLocked) {
        if (callback)
          callback({ success: false, error: "Seat is already locked" });
        return;
      }

      // Lock the seat (kicks occupant if any)
      const { kicked } = await context.seatRepository.lockSeat(
        roomId,
        seatIndex,
      );

      // If someone was kicked, notify room
      if (kicked) {
        socket.to(roomId).emit("seat:cleared", { seatIndex });
        socket.emit("seat:cleared", { seatIndex });

        logger.info(
          {
            roomId,
            userId: kicked,
            seatIndex,
            lockedBy: userId,
          },
          "User kicked from seat due to lock",
        );
      }

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
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
