/**
 * Handler for room:leave event.
 *
 * Migrated to createHandler() for consistent validation, error handling,
 * and metrics. Uses GATE → EXECUTE → REACT pipeline separation.
 */
import { createHandler, type HandlerResult } from "@src/shared/handler.utils.js";
import { leaveRoomSchema } from "@src/socket/schemas.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import type { z } from "zod";

type LeavePayload = z.infer<typeof leaveRoomSchema>;

// ── EXECUTE ─────────────────────────────────────────────────
async function processLeave(
  payload: LeavePayload,
  socket: Socket,
  context: AppContext,
) {
  const { roomId } = payload;
  const userId = String(socket.data.user.id);
  const {
    roomManager,
    clientManager,
    seatRepository,
    autoCloseService,
    userRoomRepository,
  } = context;

  // Clear user's seat if seated (using Redis)
  const seatResult = await seatRepository.leaveSeat(roomId, userId);

  // Leave socket room
  socket.leave(roomId);

  // Clear client from room index
  clientManager.clearClientRoom(socket.id);

  // Parallel Redis cleanup
  const [newCount] = await Promise.all([
    roomManager.state.adjustParticipantCount(roomId, -1),
    userRoomRepository.clearUserRoom(socket.data.user.id),
    autoCloseService.recordActivity(roomId),
  ]);

  return { roomId, userId, seatResult, newCount };
}

// ── REACT ───────────────────────────────────────────────────
function afterLeave(
  result: Awaited<ReturnType<typeof processLeave>>,
  socket: Socket,
  context: AppContext,
) {
  const { roomId, seatResult, newCount } = result;

  // Broadcast seat clear if user was seated
  if (seatResult.success && seatResult.seatIndex !== undefined) {
    emitToRoom(
      socket,
      roomId,
      "seat:cleared",
      { seatIndex: seatResult.seatIndex },
      context.cascadeRelay,
    );
    logger.debug(
      { roomId, userId: result.userId, seatIndex: seatResult.seatIndex },
      "User seat cleared on leave",
    );
  }

  // Laravel update is fire-and-forget
  if (newCount !== null) {
    const isLive = newCount > 0;
    context.laravelClient
      .updateRoomStatus(roomId, {
        is_live: isLive,
        participant_count: newCount,
        hosting_region: isLive ? config.AWS_REGION : null,
        hosting_ip: isLive
          ? config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null
          : null,
        hosting_port: isLive ? config.PORT : null,
      })
      .catch((err) =>
        logger.error({ err, roomId }, "Laravel leave status update failed"),
      );
  }

  // Notify others (cascade-aware)
  emitToRoom(
    socket,
    roomId,
    "room:userLeft",
    { userId: socket.data.user.id },
    context.cascadeRelay,
  );
}

// ── Exported Handler ────────────────────────────────────────
export const leaveRoomHandler = createHandler(
  "room:leave",
  leaveRoomSchema,
  async (payload, socket, context): Promise<HandlerResult> => {
    // EXECUTE
    const result = await processLeave(payload, socket, context);

    // REACT
    afterLeave(result, socket, context);

    return { success: true };
  },
);
