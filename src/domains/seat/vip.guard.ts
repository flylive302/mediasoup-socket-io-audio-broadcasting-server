/**
 * VIP Guard — Privilege-based protection for seated users.
 *
 * Checks if a target user has VIP anti-mute or anti-kick privileges
 * by reading their `vip_level` from `socket.data.user`.
 *
 * VIP levels and their protections (configured in Laravel VipLevelSeeder):
 *   Level 1-3: No protection
 *   Level 4+:  ANTI_MUTE (cannot be muted by room managers)
 *   Level 5+:  ANTI_KICK (cannot be removed from seat by room owners)
 */
import type { Server } from "socket.io";
import type { UserSocketRepository } from "@src/integrations/laravel/user-socket.repository.js";
import { logger } from "@src/infrastructure/logger.js";

// ============== Constants ==============

/**
 * Minimum VIP level thresholds for protections.
 * Must stay in sync with Laravel VipLevelSeeder privilege assignments.
 */
const VIP_ANTI_MUTE_MIN_LEVEL = 4;
const VIP_ANTI_KICK_MIN_LEVEL = 5;

// ============== Guard Functions ==============

/**
 * Check if a target user has VIP anti-mute protection.
 *
 * @returns true if the target is protected and should NOT be muted.
 */
export async function isVipAntiMuteProtected(
  io: Server,
  userSocketRepo: UserSocketRepository,
  targetUserId: number,
): Promise<boolean> {
  const vipLevel = await getTargetVipLevel(io, userSocketRepo, targetUserId);
  return vipLevel >= VIP_ANTI_MUTE_MIN_LEVEL;
}

/**
 * Check if a target user has VIP anti-kick protection.
 *
 * @returns true if the target is protected and should NOT be removed from seat.
 */
export async function isVipAntiKickProtected(
  io: Server,
  userSocketRepo: UserSocketRepository,
  targetUserId: number,
): Promise<boolean> {
  const vipLevel = await getTargetVipLevel(io, userSocketRepo, targetUserId);
  return vipLevel >= VIP_ANTI_KICK_MIN_LEVEL;
}

// ============== Internal Helpers ==============

/**
 * Retrieve the VIP level for a target user from their active socket data.
 * Returns 0 if user has no active sockets or vip_level is not set.
 *
 * P-5 FIX: First checks local sockets (O(k), zero network cost), then falls
 * back to cross-instance fetchSockets() via the Redis adapter. This ensures
 * VIP protection works in multi-instance deployments where the target user
 * may be connected to a different MSAB instance.
 */
async function getTargetVipLevel(
  io: Server,
  userSocketRepo: UserSocketRepository,
  targetUserId: number,
): Promise<number> {
  const socketIds = await userSocketRepo.getSocketIds(targetUserId);

  if (socketIds.length === 0) {
    return 0;
  }

  // Fast path: check local sockets first (O(k), no Redis adapter call)
  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket?.data?.user?.vip_level !== undefined) {
      return socket.data.user.vip_level as number;
    }
  }

  // P-5 FIX: Slow path — user is on a remote instance.
  // Use fetchSockets() which queries across all instances via Redis adapter.
  try {
    const remoteSockets = await io.in(socketIds).fetchSockets();
    for (const rs of remoteSockets) {
      if (rs.data?.user?.id === targetUserId && rs.data.user.vip_level !== undefined) {
        return rs.data.user.vip_level as number;
      }
    }
  } catch (err) {
    logger.warn(
      { err, targetUserId },
      "VIP guard: fetchSockets failed, defaulting to unprotected",
    );
  }

  logger.debug(
    { targetUserId },
    "VIP guard: no socket found with vip_level data",
  );
  return 0;
}

/**
 * Sync vip_level on all sockets belonging to a user.
 * Called as a post-relay side-effect when a `vip.updated` event is received.
 *
 * A-3 FIX: Uses userSocketRepo for targeted lookup instead of iterating
 * every connected socket. O(k) where k = user's sockets, not O(totalConnections).
 */
export async function syncVipLevelOnSockets(
  io: Server,
  userId: number,
  vipLevel: number,
  userSocketRepo?: UserSocketRepository,
): Promise<void> {
  if (userSocketRepo) {
    // Targeted path: only touch this user's sockets
    const socketIds = await userSocketRepo.getSocketIds(userId);
    for (const socketId of socketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket?.data?.user) {
        socket.data.user.vip_level = vipLevel;
      }
    }
  } else {
    // Fallback: iterate all sockets (legacy callers without repo reference)
    for (const [, socket] of io.sockets.sockets) {
      if (socket.data?.user?.id === userId) {
        socket.data.user.vip_level = vipLevel;
      }
    }
  }

  logger.debug(
    { userId, vipLevel },
    "VIP guard: synced vip_level on user sockets",
  );
}
