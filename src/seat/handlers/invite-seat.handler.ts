/**
 * seat:invite - Owner invites user to a seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatInviteSchema } from "../seat.requests.js";
import {
  getOrCreateRoomSeats,
  isSeatLocked,
  pendingInvites,
  INVITE_EXPIRY_MS,
  verifyRoomOwner,
} from "../seat.state.js";

export function inviteSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const startTime = Date.now();
    logger.info({ userId, payload: rawPayload }, "seat:invite received");

    try {
      const result = seatInviteSchema.safeParse(rawPayload);
      if (!result.success) {
        logger.warn({ userId, error: result.error }, "seat:invite invalid payload");
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId, seatIndex } = result.data;
      logger.info(
        { userId, roomId, targetUserId, seatIndex },
        "seat:invite verifying ownership",
      );

      if (String(targetUserId) === userId) {
        if (callback) callback({ success: false, error: "Cannot invite yourself" });
        return;
      }

      const ownership = await verifyRoomOwner(roomId, userId, context);
      const verifyTime = Date.now() - startTime;
      logger.info(
        {
          userId,
          roomId,
          targetUserId,
          seatIndex,
          allowed: ownership.allowed,
          verifyTimeMs: verifyTime,
        },
        "seat:invite ownership verified",
      );

      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      const seats = getOrCreateRoomSeats(roomId);

      // Check if seat is occupied
      if (seats.has(seatIndex)) {
        if (callback) callback({ success: false, error: "Seat is already occupied" });
        return;
      }

      // Check if seat is locked
      if (isSeatLocked(roomId, seatIndex)) {
        if (callback) callback({ success: false, error: "Seat is locked" });
        return;
      }

      // Check if there's already a pending invite for this seat
      let roomInvites = pendingInvites.get(roomId);
      if (!roomInvites) {
        roomInvites = new Map();
        pendingInvites.set(roomId, roomInvites);
      }

      if (roomInvites.has(seatIndex)) {
        if (callback) callback({ success: false, error: "Invite already pending for this seat" });
        return;
      }

      const targetUserIdStr = String(targetUserId);
      const expiresAt = Date.now() + INVITE_EXPIRY_MS;

      // Set up auto-expiry (Implicit Rejection)
      const timeoutId = setTimeout(() => {
        roomInvites?.delete(seatIndex);
        // Notify target user that invite expired
        socket.to(roomId).emit("seat:invite:expired", { seatIndex });
        // Notify room (owner) to clear pending status
        const expireEvent = { seatIndex, isPending: false };
        socket.to(roomId).emit("seat:invite:pending", expireEvent);
        socket.emit("seat:invite:pending", expireEvent);

        logger.info(
          { roomId, seatIndex, targetUserId },
          "Seat invite expired (implied rejection)",
        );
      }, INVITE_EXPIRY_MS);

      const inviterUser = socket.data.user;
      roomInvites.set(seatIndex, {
        userId: targetUserIdStr,
        seatIndex,
        invitedBy: userId,
        inviterName: inviterUser.name,
        expiresAt,
        timeoutId,
      });

      logger.info(
        { roomId, targetUserId, seatIndex, invitedBy: userId },
        "User invited to seat",
      );

      // Broadcast pending status to room (so UI can show "Invited...")
      const pendingEvent = { seatIndex, isPending: true, invitedUserId: targetUserId };
      socket.to(roomId).emit("seat:invite:pending", pendingEvent);
      socket.emit("seat:invite:pending", pendingEvent);

      // Send invite to target user (they need to be in the room)
      socket.to(roomId).emit("seat:invite:received", {
        seatIndex,
        invitedBy: {
          id: inviterUser.id,
          name: inviterUser.name,
        },
        expiresAt,
        targetUserId,
      });

      const totalTime = Date.now() - startTime;
      logger.info(
        { userId, roomId, targetUserId, seatIndex, totalTimeMs: totalTime },
        "seat:invite success",
      );

      if (callback) callback({ success: true });
    } catch (error) {
      const totalTime = Date.now() - startTime;
      logger.error(
        {
          error,
          userId,
          totalTimeMs: totalTime,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "seat:invite handler exception",
      );
      if (callback) callback({ success: false, error: "Internal server error" });
    }
  };
}
