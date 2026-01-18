/**
 * seat:take - User takes an available seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatTakeSchema } from "../seat.requests.js";
import { config } from "../../config/index.js";

export function takeSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const parseResult = seatTakeSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      if (callback) callback({ success: false, error: "Invalid payload" });
      return;
    }

    const { roomId, seatIndex } = parseResult.data;

    try {
      // Use atomic Redis operation for horizontal scaling safety
      const result = await context.seatRepository.takeSeat(
        roomId,
        userId,
        seatIndex,
        config.DEFAULT_SEAT_COUNT,
      );

      if (!result.success) {
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      logger.info({ roomId, userId, seatIndex }, "User took seat");

      // Broadcast to room
      const user = socket.data.user;
      const seatUpdate = {
        seatIndex,
        user: {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
          signature: user.signature,
          gender: user.gender,
          country: user.country,
          phone: user.phone,
          email: user.email,
          date_of_birth: user.date_of_birth,
          wealth_xp: user.economy.wealth_xp,
          charm_xp: user.economy.charm_xp,
        },
        isMuted: false,
      };

      socket.to(roomId).emit("seat:updated", seatUpdate);

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error({ error, roomId, userId, seatIndex }, "Failed to take seat");
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
