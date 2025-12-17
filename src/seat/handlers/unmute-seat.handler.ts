/**
 * seat:unmute - Owner unmutes user
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatMuteSchema } from "../seat.requests.js";
import {
  getOrCreateRoomSeats,
  findUserSeat,
  verifyRoomOwner,
} from "../seat.state.js";

export function unmuteSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const result = seatMuteSchema.safeParse(rawPayload);
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
    const seat = seats.get(seatIndex);
    if (seat) {
      seat.muted = false;
    }

    logger.info(
      { roomId, targetUserId, seatIndex, unmutedBy: userId },
      "User unmuted",
    );

    // Resume audio on the server side
    const targetClient = context.clientManager
      .getClientsInRoom(roomId)
      .find((c) => String(c.userId) === targetUserIdStr);

    if (targetClient) {
      const audioProducerId = targetClient.producers.get("audio");
      if (audioProducerId) {
        const room = await context.roomManager.getRoom(roomId);
        const producer = room?.getProducer(audioProducerId);
        if (producer) {
          await producer.resume();
          logger.info(
            { roomId, targetUserId, producerId: audioProducerId },
            "Producer resumed (server-side unmute)",
          );
        }
      }
    }

    socket.to(roomId).emit("seat:userMuted", {
      userId: targetUserId,
      isMuted: false,
    });
    // Also emit to sender so their UI updates
    socket.emit("seat:userMuted", {
      userId: targetUserId,
      isMuted: false,
    });

    if (callback) callback({ success: true });
  };
}
