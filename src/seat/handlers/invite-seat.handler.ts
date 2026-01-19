/**
 * seat:invite - Owner/Admin invites user to a seat
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { seatInviteSchema } from "../seat.requests.js";
import { verifyRoomManager } from "../seat.owner.js";

// Invite expiry in seconds (30 seconds TTL in Redis)
const INVITE_EXPIRY_SECONDS = 30;

export function inviteSeatHandler(socket: Socket, context: AppContext) {
  const userId = String(socket.data.user.id);

  return async (
    rawPayload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const startTime = Date.now();
    logger.info({ userId, payload: rawPayload }, "seat:invite received");

    try {
      const parseResult = seatInviteSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        logger.warn(
          { userId, error: parseResult.error },
          "seat:invite invalid payload",
        );
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId, seatIndex } = parseResult.data;
      logger.info(
        { userId, roomId, targetUserId, seatIndex },
        "seat:invite verifying ownership",
      );

      if (String(targetUserId) === userId) {
        if (callback)
          callback({ success: false, error: "Cannot invite yourself" });
        return;
      }

      const authorization = await verifyRoomManager(roomId, userId, context);
      const verifyTime = Date.now() - startTime;
      logger.info(
        {
          userId,
          roomId,
          targetUserId,
          seatIndex,
          allowed: authorization.allowed,
          verifyTimeMs: verifyTime,
        },
        "seat:invite authorization verified",
      );

      if (!authorization.allowed) {
        if (callback) callback({ success: false, error: authorization.error });
        return;
      }

      // Note: Locked seats can now be invited to - will auto-unlock when user accepts

      // Check if seat is occupied (using Redis)
      const seat = await context.seatRepository.getSeat(roomId, seatIndex);
      if (seat?.userId) {
        if (callback)
          callback({ success: false, error: "Seat is already occupied" });
        return;
      }

      // Check if there's already a pending invite for this seat (using Redis)
      const existingInvite = await context.seatRepository.getInvite(
        roomId,
        seatIndex,
      );
      if (existingInvite) {
        if (callback)
          callback({
            success: false,
            error: "Invite already pending for this seat",
          });
        return;
      }

      const targetUserIdStr = String(targetUserId);

      // Create invite with TTL in Redis (no setTimeout needed - Redis handles expiry)
      const success = await context.seatRepository.createInvite(
        roomId,
        seatIndex,
        targetUserIdStr,
        userId,
        INVITE_EXPIRY_SECONDS,
      );

      if (!success) {
        if (callback)
          callback({ success: false, error: "Failed to create invite" });
        return;
      }

      const expiresAt = Date.now() + INVITE_EXPIRY_SECONDS * 1000;

      logger.info(
        { roomId, targetUserId, seatIndex, invitedBy: userId },
        "User invited to seat",
      );

      // Broadcast pending status to room (so UI can show "Invited...")
      const pendingEvent = {
        seatIndex,
        isPending: true,
        invitedUserId: targetUserId,
      };
      socket.to(roomId).emit("seat:invite:pending", pendingEvent);
      socket.emit("seat:invite:pending", pendingEvent);

      // Send invite ONLY to target user using proper MSAB pattern
      // Uses Redis-backed userSocketRepository for horizontal scalability
      const inviterUser = socket.data.user;
      const inviteEvent = {
        seatIndex,
        invitedBy: {
          id: inviterUser.id,
          name: inviterUser.name,
        },
        expiresAt,
        targetUserId,
      };

      const targetSocketIds = await context.userSocketRepository.getSocketIds(
        Number(targetUserId),
      );

      if (targetSocketIds.length > 0) {
        for (const socketId of targetSocketIds) {
          context.io.to(socketId).emit("seat:invite:received", inviteEvent);
        }
        logger.info(
          { roomId, targetUserId, seatIndex, socketCount: targetSocketIds.length },
          "Sent seat invite to target user sockets",
        );
      } else {
        logger.warn(
          { roomId, targetUserId, seatIndex },
          "Target user has no active sockets - invite may not be received",
        );
      }

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
      if (callback)
        callback({ success: false, error: "Internal server error" });
    }
  };
}
