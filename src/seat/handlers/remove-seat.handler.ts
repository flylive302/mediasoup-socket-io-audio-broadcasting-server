/**
 * seat:remove - Owner removes user from seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatRemoveSchema } from "../seat.requests.js";
import {
  getOrCreateRoomSeats,
  findUserSeat,
  verifyRoomOwner,
} from "../seat.state.js";

export function removeSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const result = seatRemoveSchema.safeParse(rawPayload);
    if (!result.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId, userId: targetUserId } = result.data;

    const ownership = await verifyRoomOwner(roomId, userId, context);
    if (!ownership.allowed) {
      if (callback) callback({ success: false, error: ownership.error });
      return;
    }

    const targetUserIdStr = String(targetUserId);
    const seatIndex = findUserSeat(roomId, targetUserIdStr);

    if (seatIndex === null) {
      if (callback) callback({ success: false, error: "User is not seated" });
      return;
    }

    const seats = getOrCreateRoomSeats(roomId);
    seats.delete(seatIndex);

    logger.info(
      { roomId, targetUserId, seatIndex, removedBy: userId },
      "User removed from seat",
    );

    socket.to(roomId).emit("seat:cleared", { seatIndex });

    if (callback) callback({ success: true });
  };
}
