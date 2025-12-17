/**
 * seat:mute - Owner mutes user
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

export function muteSeatHandler(socket: Socket, context: AppContext) {
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
      seat.muted = true;
    }

    logger.info(
      { roomId, targetUserId, seatIndex, mutedBy: userId },
      "User muted",
    );

    // Enforce silence on the server side by pausing the producer
    const targetClient = context.clientManager
      .getClientsInRoom(roomId)
      .find((c) => String(c.userId) === targetUserIdStr);

    if (targetClient) {
      const audioProducerId = targetClient.producers.get("audio");
      if (audioProducerId) {
        const room = await context.roomManager.getRoom(roomId);
        const producer = room?.getProducer(audioProducerId);
        if (producer) {
          await producer.pause();
          logger.info(
            { roomId, targetUserId, producerId: audioProducerId },
            "Producer paused (server-side mute)",
          );
        }
      }
    }

    socket.to(roomId).emit("seat:userMuted", {
      userId: targetUserId,
      isMuted: true,
    });
    // Also emit to sender so their UI updates
    socket.emit("seat:userMuted", {
      userId: targetUserId,
      isMuted: true,
    });

    if (callback) callback({ success: true });
  };
}
