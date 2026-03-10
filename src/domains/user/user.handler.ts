/**
 * User Handler - User-related socket events
 * 
 * Handles user:getRoom for tracking feature
 * Handles user:profileSync for immediate profile propagation to rooms
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import { getUserRoomSchema, profileSyncSchema } from "@src/socket/schemas.js";
import { Errors } from "@src/shared/errors.js";
import type { User } from "@src/auth/types.js";

export const userHandler = (socket: Socket, context: AppContext) => {
  const { userRoomRepository, clientManager, io } = context;

  /**
   * Get the room a user is currently in
   * Used for Track feature on profile page
   */
  socket.on("user:getRoom", async (rawPayload: unknown, ack) => {
    const parseResult = getUserRoomSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      if (ack) ack({ roomId: null, error: Errors.INVALID_PAYLOAD });
      return;
    }

    const { userId } = parseResult.data;

    try {
      const roomId = await userRoomRepository.getUserRoom(userId);
      
      logger.debug({ userId, roomId }, "user:getRoom result");
      
      if (ack) ack({ roomId });
    } catch (err) {
      logger.error({ err, userId }, "user:getRoom failed");
      if (ack) ack({ roomId: null, error: Errors.INTERNAL_ERROR });
    }
  });

  /**
   * Immediate profile sync from frontend.
   *
   * Called after profile-modifying API calls (equip frame, update avatar, etc.)
   * so other room participants see the change instantly without waiting for the
   * queued Laravel → SNS/HTTP → MSAB pipeline.
   *
   * Security: the user ID comes from socket.data.user (JWT-authenticated),
   * NOT from the payload. The payload only carries the changed visual fields.
   */
  socket.on("user:profileSync", (rawPayload: unknown, ack) => {
    const user = socket.data?.user as User | undefined;
    if (!user) {
      if (ack) ack({ success: false, error: Errors.NOT_AUTHORIZED });
      return;
    }

    const parseResult = profileSyncSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      if (ack) ack({ success: false, error: Errors.INVALID_PAYLOAD });
      return;
    }

    const { profile } = parseResult.data;

    try {
      // 1. Update ClientManager in-memory user data
      const affectedRooms = clientManager.updateUserProfile(
        user.id,
        profile as Partial<User>,
      );

      // 2. Sync socket.data.user on all live sockets for this user
      for (const [, s] of io.sockets.sockets) {
        if (s.data?.user?.id === user.id) {
          s.data.user = { ...s.data.user, ...profile };
        }
      }

      // 3. Broadcast to rooms so other clients can refresh UI
      for (const roomId of affectedRooms) {
        io.to(roomId).emit("user:profile_updated", {
          user_id: user.id,
          profile,
        });
      }

      logger.info(
        { userId: user.id, rooms: affectedRooms.size, fields: Object.keys(profile) },
        "user:profileSync applied",
      );

      if (ack) ack({ success: true });
    } catch (err) {
      logger.error({ err, userId: user.id }, "user:profileSync failed");
      if (ack) ack({ success: false, error: Errors.INTERNAL_ERROR });
    }
  });
};
