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
import {
  getOrCreateRoomSeats,
  findUserSeat,
  isSeatLocked,
  pendingInvites,
  type PendingInvite,
} from "../seat.state.js";

export function inviteAcceptHandler(socket: Socket, _context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    logger.info({ userId, rawPayload }, "seat:invite:accept received");

    try {
      const result = seatInviteActionSchema.safeParse(rawPayload);
      if (!result.success) {
        logger.warn({ userId, errors: result.error.format() }, "seat:invite:accept invalid payload");
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = result.data;
      let { seatIndex } = result.data;
      const roomInvites = pendingInvites.get(roomId);

      // If seatIndex not provided, find the invite for this user
      let invite: PendingInvite | undefined;
      if (seatIndex !== undefined) {
        invite = roomInvites?.get(seatIndex);
      } else {
        // Look up invite by userId
        if (roomInvites) {
          for (const [idx, inv] of roomInvites) {
            if (inv.userId === userId) {
              invite = inv;
              seatIndex = idx;
              break;
            }
          }
        }
      }

      logger.info(
        {
          roomId,
          seatIndex,
          acceptingUserId: userId,
          inviteUserId: invite?.userId,
          hasInvite: !!invite,
          hasRoomInvites: !!roomInvites,
        },
        "seat:invite:accept checking invite",
      );

      // Verify invite exists and matches user
      if (!invite || invite.userId !== userId || seatIndex === undefined) {
        logger.warn(
          { roomId, seatIndex, userId, inviteUserId: invite?.userId },
          "seat:invite:accept - no matching invite found",
        );
        if (callback) callback({ success: false, error: "No pending invite found" });
        return;
      }

      // Clear the pending invite since user responded
      if (invite.timeoutId) clearTimeout(invite.timeoutId);
      roomInvites?.delete(seatIndex);

      // Notify room that pending status is cleared
      const clearEvent = { seatIndex, isPending: false };
      socket.to(roomId).emit("seat:invite:pending", clearEvent);
      socket.emit("seat:invite:pending", clearEvent);

      // User Accepted: Proceed to take seat
      const seats = getOrCreateRoomSeats(roomId);

      // Double check availability
      if (seats.has(seatIndex) || isSeatLocked(roomId, seatIndex)) {
        if (callback) callback({ success: false, error: "Seat is no longer available" });
        return;
      }

      // Check if user is already seated elsewhere and remove them
      const existingSeat = findUserSeat(roomId, userId);
      if (existingSeat !== null) {
        seats.delete(existingSeat);
        socket.to(roomId).emit("seat:cleared", { seatIndex: existingSeat });
      }

      // Assign seat
      seats.set(seatIndex, { userId, muted: false });

      logger.info({ roomId, userId, seatIndex }, "User accepted invite and took seat");

      // Broadcast update
      const user = socket.data.user;
      const seatUpdate = {
        seatIndex,
        user: {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
        },
        isMuted: false,
      };

      socket.to(roomId).emit("seat:updated", seatUpdate);
      socket.emit("seat:updated", seatUpdate);

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error(
        { error, userId, stack: error instanceof Error ? error.stack : undefined },
        "seat:invite:accept handler exception",
      );
      if (callback) callback({ success: false, error: "Internal server error" });
    }
  };
}

export function inviteDeclineHandler(socket: Socket, _context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    logger.info({ userId, rawPayload }, "seat:invite:decline received");

    try {
      const result = seatInviteActionSchema.safeParse(rawPayload);
      if (!result.success) {
        logger.warn({ userId, errors: result.error.format() }, "seat:invite:decline invalid payload");
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = result.data;
      let { seatIndex } = result.data;
      const roomInvites = pendingInvites.get(roomId);

      // If seatIndex not provided, find the invite for this user
      let invite: PendingInvite | undefined;
      if (seatIndex !== undefined) {
        invite = roomInvites?.get(seatIndex);
      } else {
        // Look up invite by userId
        if (roomInvites) {
          for (const [idx, inv] of roomInvites) {
            if (inv.userId === userId) {
              invite = inv;
              seatIndex = idx;
              break;
            }
          }
        }
      }

      logger.info(
        {
          roomId,
          seatIndex,
          decliningUserId: userId,
          inviteUserId: invite?.userId,
          hasInvite: !!invite,
          hasRoomInvites: !!roomInvites,
        },
        "seat:invite:decline checking invite",
      );

      // Verify invite exists and matches user
      if (!invite || invite.userId !== userId || seatIndex === undefined) {
        logger.warn(
          { roomId, seatIndex, userId, inviteUserId: invite?.userId },
          "seat:invite:decline - no matching invite found",
        );
        if (callback) callback({ success: false, error: "No pending invite found" });
        return;
      }

      // Clear the pending invite since user responded
      if (invite.timeoutId) clearTimeout(invite.timeoutId);
      roomInvites?.delete(seatIndex);

      // Notify room that pending status is cleared
      const clearEvent = { seatIndex, isPending: false };
      socket.to(roomId).emit("seat:invite:pending", clearEvent);
      socket.emit("seat:invite:pending", clearEvent);

      logger.info({ roomId, userId, seatIndex }, "User declined seat invite");

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error(
        { error, userId, stack: error instanceof Error ? error.stack : undefined },
        "seat:invite:decline handler exception",
      );
      if (callback) callback({ success: false, error: "Internal server error" });
    }
  };
}
