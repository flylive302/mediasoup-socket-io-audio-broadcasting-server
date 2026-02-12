/**
 * seat:invite:accept - User accepts an invite
 * seat:invite:decline - User declines an invite
 *
 * Both handlers are combined since they share most logic
 */
import { seatInviteActionSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";


export const inviteAcceptHandler = createHandler(
  "seat:invite:accept",
  seatInviteActionSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId } = payload;
    let { seatIndex } = payload;

    // If seatIndex not provided, find the invite for this user
    let invite;
    if (seatIndex !== undefined) {
      invite = await context.seatRepository.getInvite(roomId, seatIndex);
    } else {
      // Search for user's invite
      const found = await context.seatRepository.getInviteByUser(roomId, userId);
      if (found) {
        invite = found.invite;
        seatIndex = found.seatIndex;
      }
    }

    logger.info(
      {
        roomId,
        seatIndex,
        acceptingUserId: userId,
        inviteTargetUserId: invite?.targetUserId,
        hasInvite: !!invite,
      },
      "seat:invite:accept checking invite",
    );

    // Verify invite exists and matches user
    if (!invite || invite.targetUserId !== userId || seatIndex === undefined) {
      return { success: false, error: Errors.NO_INVITE };
    }

    // Delete the invite from Redis (no clearTimeout needed - Redis TTL handles expiry)
    await context.seatRepository.deleteInvite(roomId, seatIndex);

    // Notify room that pending status is cleared
    socket.nsp.to(roomId).emit("seat:invite:pending", {
      seatIndex,
      isPending: false,
    });

    // Auto-unlock seat if locked (invited users bypass seat lock)
    // SEAT-002: unlockSeat now returns SeatActionResult — ignore errors (best-effort)
    const unlockResult = await context.seatRepository.unlockSeat(roomId, seatIndex);
    if (unlockResult.success) {
      socket.nsp.to(roomId).emit("seat:locked", { seatIndex, isLocked: false });
      logger.info({ roomId, seatIndex, userId }, "Seat auto-unlocked for invited user");
    }

    // SEAT-009: Use actual per-room seatCount from state
    const roomState = await context.roomManager.state.get(roomId);
    const seatCount = roomState?.seatCount ?? config.DEFAULT_SEAT_COUNT;

    // User Accepted: Use atomic Redis operation to take seat
    const result = await context.seatRepository.takeSeat(
      roomId,
      userId,
      seatIndex,
      seatCount,
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    logger.info(
      { roomId, userId, seatIndex },
      "User accepted invite and took seat",
    );

    // BL-007 FIX: userId-only — frontend looks up user from participants
    socket.nsp.to(roomId).emit("seat:updated", {
      seatIndex,
      userId: socket.data.user.id,
      isMuted: false,
    });

    return { success: true };
  },
);

export const inviteDeclineHandler = createHandler(
  "seat:invite:decline",
  seatInviteActionSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId } = payload;
    let { seatIndex } = payload;

    // If seatIndex not provided, find the invite for this user
    let invite;
    if (seatIndex !== undefined) {
      invite = await context.seatRepository.getInvite(roomId, seatIndex);
    } else {
      // Search for user's invite
      const found = await context.seatRepository.getInviteByUser(roomId, userId);
      if (found) {
        invite = found.invite;
        seatIndex = found.seatIndex;
      }
    }

    logger.info(
      {
        roomId,
        seatIndex,
        decliningUserId: userId,
        inviteTargetUserId: invite?.targetUserId,
        hasInvite: !!invite,
      },
      "seat:invite:decline checking invite",
    );

    // Verify invite exists and matches user
    if (!invite || invite.targetUserId !== userId || seatIndex === undefined) {
      return { success: false, error: Errors.NO_INVITE };
    }

    // Delete the invite from Redis
    await context.seatRepository.deleteInvite(roomId, seatIndex);

    // Notify room that pending status is cleared
    socket.nsp.to(roomId).emit("seat:invite:pending", {
      seatIndex,
      isPending: false,
    });

    logger.info({ roomId, userId, seatIndex }, "User declined seat invite");

    return { success: true };
  },
);