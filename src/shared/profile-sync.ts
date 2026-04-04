/**
 * Shared profile sync utility — DRY extraction (A-2 FIX)
 *
 * Contains the 3-step profile sync logic used by both:
 *  1. user:profileSync socket handler (frontend-initiated)
 *  2. user.profile.updated relay handler (Laravel-initiated)
 *
 * Steps:
 *  1. Update ClientManager in-memory user data
 *  2. Sync socket.data.user on all live sockets for this user
 *  3. Broadcast to rooms so other clients can refresh UI
 */
import type { Server } from "socket.io";
import type { ClientManager } from "@src/client/clientManager.js";
import type { User } from "@src/auth/types.js";
import type { UserSocketRepository } from "@src/integrations/laravel/user-socket.repository.js";

/**
 * Sync a user's profile across all in-memory stores and broadcast to rooms.
 *
 * @param io - Socket.IO server instance
 * @param clientManager - In-memory client state manager
 * @param userId - The user whose profile changed
 * @param profile - Partial user profile fields to merge
 * @param userSocketRepo - Optional; if provided, uses targeted O(k) socket lookup
 * @returns Set of affected room IDs
 */
export async function syncUserProfileInMemory(
  io: Server,
  clientManager: ClientManager,
  userId: number,
  profile: Partial<User>,
  userSocketRepo?: UserSocketRepository,
): Promise<Set<string>> {
  // 1. Update ClientManager in-memory user data
  const affectedRooms = clientManager.updateUserProfile(userId, profile);

  // 2. Sync socket.data.user on all live sockets for this user
  // A-3 FIX: Use targeted lookup when userSocketRepo is available
  if (userSocketRepo) {
    const socketIds = await userSocketRepo.getSocketIds(userId);
    for (const socketId of socketIds) {
      const s = io.sockets.sockets.get(socketId);
      if (s?.data?.user) {
        s.data.user = { ...s.data.user, ...profile };
      }
    }
  } else {
    for (const [, s] of io.sockets.sockets) {
      if (s.data?.user?.id === userId) {
        s.data.user = { ...s.data.user, ...profile };
      }
    }
  }

  // 3. Broadcast to rooms so other clients can refresh UI
  for (const roomId of affectedRooms) {
    io.to(roomId).emit("user:profile_updated", {
      user_id: userId,
      profile,
    });
  }

  return affectedRooms;
}
