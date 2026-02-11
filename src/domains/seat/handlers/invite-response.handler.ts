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
import { emitToRoom } from "@src/shared/socket.utils.js";

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
      const found = await context.seatRepository.findInviteByUser(roomId, userId);
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
    emitToRoom(socket, roomId, "seat:invite:pending", {
      seatIndex,
      isPending: false,
    });

    // Auto-unlock seat if locked (invited users bypass seat lock)
    const isLocked = await context.seatRepository.isSeatLocked(roomId, seatIndex);
    if (isLocked) {
      await context.seatRepository.unlockSeat(roomId, seatIndex);
      emitToRoom(socket, roomId, "seat:locked", { seatIndex, isLocked: false });
      logger.info({ roomId, seatIndex, userId }, "Seat auto-unlocked for invited user");
    }

    // User Accepted: Use atomic Redis operation to take seat
    const result = await context.seatRepository.takeSeat(
      roomId,
      userId,
      seatIndex,
      config.DEFAULT_SEAT_COUNT,
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    logger.info(
      { roomId, userId, seatIndex },
      "User accepted invite and took seat",
    );

    // BL-007 FIX: userId-only — frontend looks up user from participants
    emitToRoom(socket, roomId, "seat:updated", {
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
      const found = await context.seatRepository.findInviteByUser(roomId, userId);
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
    emitToRoom(socket, roomId, "seat:invite:pending", {
      seatIndex,
      isPending: false,
    });

    logger.info({ roomId, userId, seatIndex }, "User declined seat invite");

    return { success: true };
  },
);
