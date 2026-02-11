/**
 * seat:invite - Owner/Admin invites user to a seat
 */
import { seatInviteSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";
import { emitToRoom } from "@src/shared/socket.utils.js";

// Invite expiry in seconds (30 seconds TTL in Redis)
const INVITE_EXPIRY_SECONDS = 30;

export const inviteSeatHandler = createHandler(
  "seat:invite",
  seatInviteSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, userId: targetUserId, seatIndex } = payload;

    if (String(targetUserId) === userId) {
      return { success: false, error: Errors.CANNOT_INVITE_SELF };
    }

    const authorization = await verifyRoomManager(roomId, userId, context);
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }

    // Note: Locked seats can now be invited to - will auto-unlock when user accepts

    // Check if seat is occupied (using Redis)
    const seat = await context.seatRepository.getSeat(roomId, seatIndex);
    if (seat?.userId) {
      return { success: false, error: Errors.SEAT_OCCUPIED };
    }

    // Check if there's already a pending invite for this seat (using Redis)
    const existingInvite = await context.seatRepository.getInvite(
      roomId,
      seatIndex,
    );
    if (existingInvite) {
      return { success: false, error: Errors.INVITE_PENDING };
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
      return { success: false, error: Errors.INVITE_CREATE_FAILED };
    }

    const expiresAt = Date.now() + INVITE_EXPIRY_SECONDS * 1000;

    logger.info(
      { roomId, targetUserId, seatIndex, invitedBy: userId },
      "User invited to seat",
    );

    // Broadcast pending status to room (so UI can show "Invited...")
    emitToRoom(socket, roomId, "seat:invite:pending", {
      seatIndex,
      isPending: true,
      invitedUserId: targetUserId,
    });

    // BL-007 FIX: userId-only — frontend looks up inviter from participants
    const inviteEvent = {
      seatIndex,
      invitedById: socket.data.user.id,
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

    return { success: true };
  },
);
