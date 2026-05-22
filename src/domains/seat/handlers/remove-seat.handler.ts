/**
 * seat:remove - Owner removes user from their seat
 */
import { seatRemoveSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { verifyRoomOwner } from "@src/domains/seat/seat.owner.js";
import { isVipAntiKickProtected } from "@src/domains/seat/vip.guard.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";

export const removeSeatHandler = createHandler(
  "seat:remove",
  seatRemoveSchema,
  async (payload, socket, context) => {
    const requesterId = String(socket.data.user.id);
    const { roomId, userId: targetUserId } = payload;

    const ownership = await verifyRoomOwner(roomId, requesterId, context);
    if (!ownership.allowed) {
      return { success: false, error: ownership.error };
    }

    // VIP anti-kick guard
    const isProtected = await isVipAntiKickProtected(
      context.io,
      context.userSocketRepository,
      targetUserId,
    );
    if (isProtected) {
      logger.info(
        { roomId, targetUserId, requesterId },
        "VIP anti-kick: target user is protected",
      );
      return { success: false, error: Errors.VIP_PROTECTED };
    }

    const targetUserIdStr = String(targetUserId);
    const result = await context.seatRepository.removeSeat(roomId, targetUserIdStr);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // F-41: removeSeat (leaveSeat) clears EVERY seat the user held.
    const cleared = result.clearedSeatIndices ?? [result.seatIndex];
    logger.info(
      { roomId, targetUserId, clearedSeatIndices: cleared, removedBy: requesterId },
      "User removed from seat",
    );

    // Broadcast to room (cascade-aware)
    for (const seatIndex of cleared) {
      emitToRoom(
        socket,
        roomId,
        "seat:cleared",
        { seatIndex, userId: targetUserId },
        context.cascadeRelay,
      );
    }

    return { success: true };
  },
);
