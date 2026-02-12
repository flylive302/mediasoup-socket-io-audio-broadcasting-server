/**
 * seat:take - User takes an available seat
 */
import { seatTakeSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";

export const takeSeatHandler = createHandler(
  "seat:take",
  seatTakeSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, seatIndex } = payload;

    // SEAT-009: Use actual per-room seatCount from state
    const roomState = await context.roomManager.state.get(roomId);
    const seatCount = roomState?.seatCount ?? config.DEFAULT_SEAT_COUNT;

    // Use atomic Redis operation for horizontal scaling safety
    const result = await context.seatRepository.takeSeat(
      roomId,
      userId,
      seatIndex,
      seatCount,
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    logger.info({ roomId, userId, seatIndex }, "User took seat");

    // BL-007 FIX: userId-only — frontend looks up user from participants
    socket.to(roomId).emit("seat:updated", {
      seatIndex,
      userId: socket.data.user.id,
      isMuted: false,
    });

    // BL-001 FIX: Record room activity to prevent auto-close during seat actions
    context.autoCloseService.recordActivity(roomId).catch(() => {});

    return { success: true };
  },
);
