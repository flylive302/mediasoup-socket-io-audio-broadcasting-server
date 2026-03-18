/**
 * room:kick - Owner/Admin kicks a user out of the room
 *
 * Authorization: verifyRoomManager (owner or admin)
 * Side effects:
 *   1. Clears user's seat if seated
 *   2. Emits room:kicked to the target user
 *   3. Force-leaves the user from the Socket.IO room
 *   4. Broadcasts room:userLeft to remaining participants
 *   5. Updates participant count
 */
import { roomKickSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { isVipAntiKickProtected } from "@src/domains/seat/vip.guard.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";
import { config } from "@src/config/index.js";

export const kickUserHandler = createHandler(
  "room:kick",
  roomKickSchema,
  async (payload, socket, context) => {
    const requesterId = String(socket.data.user.id);
    const { roomId, userId: targetUserId } = payload;

    // 1. Verify requester is owner or admin
    const auth = await verifyRoomManager(roomId, requesterId, context);
    if (!auth.allowed) {
      return { success: false, error: auth.error };
    }

    // 2. Prevent kicking self
    if (String(targetUserId) === requesterId) {
      return { success: false, error: Errors.NOT_AUTHORIZED };
    }

    // 3. VIP anti-kick guard
    const isProtected = await isVipAntiKickProtected(
      context.io,
      context.userSocketRepository,
      targetUserId,
    );
    if (isProtected) {
      logger.info(
        { roomId, targetUserId, requesterId },
        "VIP anti-kick: target user is protected",
      );
      return { success: false, error: Errors.VIP_PROTECTED };
    }

    // 4. Clear user's seat if seated
    const targetUserIdStr = String(targetUserId);
    const seatResult = await context.seatRepository.leaveSeat(roomId, targetUserIdStr);
    if (seatResult.success && seatResult.seatIndex !== undefined) {
      emitToRoom(socket, roomId, "seat:cleared", { seatIndex: seatResult.seatIndex }, context.cascadeRelay);
      logger.debug(
        { roomId, targetUserId, seatIndex: seatResult.seatIndex },
        "Kicked user's seat cleared",
      );
    }

    // 5. Find the target user's socket(s) and emit kick event
    const targetSocketIds = await context.userSocketRepository.getSocketIds(targetUserId);
    for (const socketId of targetSocketIds) {
      const targetSocket = context.io.sockets.sockets.get(socketId);
      if (targetSocket) {
        // Emit kick notification to the target user
        targetSocket.emit("room:kicked", {
          roomId,
          reason: "kicked_by_admin",
        });

        // Force-leave the user from the Socket.IO room
        targetSocket.leave(roomId);

        // Clean up client manager state
        context.clientManager.clearClientRoom(socketId);
      }
    }

    // 6. Update room state
    const [newCount] = await Promise.all([
      context.roomManager.state.adjustParticipantCount(roomId, -1),
      context.userRoomRepository.clearUserRoom(targetUserId),
    ]);

    // 7. Update Laravel (fire-and-forget)
    if (newCount !== null) {
      const isLive = newCount > 0;
      context.laravelClient
        .updateRoomStatus(roomId, {
          is_live: isLive,
          participant_count: newCount,
          hosting_region: isLive ? config.AWS_REGION : null,
          hosting_ip: isLive ? (config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null) : null,
          hosting_port: isLive ? config.PORT : null,
        })
        .catch((err) =>
          logger.error({ err, roomId }, "Laravel kick status update failed"),
        );
    }

    // 8. Broadcast to remaining room members (cascade-aware)
    emitToRoom(socket, roomId, "room:userLeft", { userId: targetUserId }, context.cascadeRelay);

    logger.info(
      { roomId, targetUserId, kickedBy: requesterId },
      "User kicked from room",
    );

    return { success: true };
  },
);
