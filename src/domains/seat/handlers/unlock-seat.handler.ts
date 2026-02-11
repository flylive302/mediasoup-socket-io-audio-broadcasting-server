/**
 * seat:unlock - Owner/Admin unlocks a seat
 */
import { seatLockSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";


export const unlockSeatHandler = createHandler(
  "seat:unlock",
  seatLockSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, seatIndex } = payload;

    const authorization = await verifyRoomManager(roomId, userId, context);
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }

    // Check if not locked (using Redis)
    const isLocked = await context.seatRepository.isSeatLocked(
      roomId,
      seatIndex,
    );
    if (!isLocked) {
      return { success: false, error: Errors.SEAT_NOT_LOCKED };
    }

    // Unlock the seat (using Redis)
    await context.seatRepository.unlockSeat(roomId, seatIndex);

    logger.info({ roomId, seatIndex, unlockedBy: userId }, "Seat unlocked");

    // Broadcast to all including sender
    socket.nsp.to(roomId).emit("seat:locked", { seatIndex, isLocked: false });

    return { success: true };
  },
);
