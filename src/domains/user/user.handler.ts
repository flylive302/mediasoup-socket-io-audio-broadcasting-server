/**
 * User Handler - User-related socket events
 *
 * Handles user:getRoom for tracking feature
 * Handles user:profileSync for immediate profile propagation to rooms
 *
 * Migrated to createHandler() for consistent validation, error handling,
 * correlation IDs, and metrics — matching all other domain handlers.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import { getUserRoomSchema, profileSyncSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { Errors } from "@src/shared/errors.js";
import type { User } from "@src/auth/types.js";

/**
 * Get the room a user is currently in.
 * Used for Track feature on profile page.
 */
const getUserRoomHandler = createHandler(
  "user:getRoom",
  getUserRoomSchema,
  async (payload, _socket, context) => {
    const roomId = await context.userRoomRepository.getUserRoom(payload.userId);

    logger.debug({ userId: payload.userId, roomId }, "user:getRoom result");

    return { success: true, data: { roomId } };
  }
);

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
const profileSyncHandler = createHandler(
  "user:profileSync",
  profileSyncSchema,
  async (payload, socket, context) => {
    const { clientManager, io } = context;
    const user = socket.data?.user as User | undefined;

    if (!user) {
      return { success: false, error: Errors.NOT_AUTHORIZED };
    }

    const { profile } = payload;

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

    return { success: true };
  }
);

export const userHandler = (socket: Socket, context: AppContext) => {
  socket.on("user:getRoom", getUserRoomHandler(socket, context));
  socket.on("user:profileSync", profileSyncHandler(socket, context));
};
