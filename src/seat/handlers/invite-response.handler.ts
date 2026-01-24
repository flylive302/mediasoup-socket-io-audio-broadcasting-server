/**
 * seat:invite:accept - User accepts an invite
 * seat:invite:decline - User declines an invite
 *
 * Both handlers are combined since they share most logic
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatInviteActionSchema } from "../seat.requests.js";
import { config } from "../../config/index.js";

export function inviteAcceptHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    logger.info({ userId, rawPayload }, "seat:invite:accept received");

    try {
      const parseResult = seatInviteActionSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        logger.warn(
          { userId, errors: parseResult.error.format() },
          "seat:invite:accept invalid payload",
        );
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = parseResult.data;
      let { seatIndex } = parseResult.data;

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
        logger.warn(
          {
            roomId,
            seatIndex,
            userId,
            inviteTargetUserId: invite?.targetUserId,
          },
          "seat:invite:accept - no matching invite found",
        );
        if (callback)
          callback({ success: false, error: "No pending invite found" });
        return;
      }

      // Delete the invite from Redis (no clearTimeout needed - Redis TTL handles expiry)
      await context.seatRepository.deleteInvite(roomId, seatIndex);

      // Notify room that pending status is cleared
      const clearEvent = { seatIndex, isPending: false };
      socket.to(roomId).emit("seat:invite:pending", clearEvent);
      socket.emit("seat:invite:pending", clearEvent);

      // Auto-unlock seat if locked (invited users bypass seat lock)
      const isLocked = await context.seatRepository.isSeatLocked(roomId, seatIndex);
      if (isLocked) {
        await context.seatRepository.unlockSeat(roomId, seatIndex);
        // Broadcast unlock event
        const unlockEvent = { seatIndex, isLocked: false };
        socket.to(roomId).emit("seat:locked", unlockEvent);
        socket.emit("seat:locked", unlockEvent);
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
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      logger.info(
        { roomId, userId, seatIndex },
        "User accepted invite and took seat",
      );

      // Broadcast update
      const user = socket.data.user;
      const seatUpdate = {
        seatIndex,
        user: {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
          signature: user.signature,
          frame: user.frame,
          gender: user.gender,
          country: user.country,
          phone: user.phone,
          email: user.email,
          date_of_birth: user.date_of_birth,
          wealth_xp: user.wealth_xp,
          charm_xp: user.charm_xp,
        },
        isMuted: false,
      };

      socket.to(roomId).emit("seat:updated", seatUpdate);
      socket.emit("seat:updated", seatUpdate);

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error(
        {
          error,
          userId,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "seat:invite:accept handler exception",
      );
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}

export function inviteDeclineHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    logger.info({ userId, rawPayload }, "seat:invite:decline received");

    try {
      const parseResult = seatInviteActionSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        logger.warn(
          { userId, errors: parseResult.error.format() },
          "seat:invite:decline invalid payload",
        );
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = parseResult.data;
      let { seatIndex } = parseResult.data;

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
        logger.warn(
          {
            roomId,
            seatIndex,
            userId,
            inviteTargetUserId: invite?.targetUserId,
          },
          "seat:invite:decline - no matching invite found",
        );
        if (callback)
          callback({ success: false, error: "No pending invite found" });
        return;
      }

      // Delete the invite from Redis
      await context.seatRepository.deleteInvite(roomId, seatIndex);

      // Notify room that pending status is cleared
      const clearEvent = { seatIndex, isPending: false };
      socket.to(roomId).emit("seat:invite:pending", clearEvent);
      socket.emit("seat:invite:pending", clearEvent);

      logger.info({ roomId, userId, seatIndex }, "User declined seat invite");

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error(
        {
          error,
          userId,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "seat:invite:decline handler exception",
      );
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}

