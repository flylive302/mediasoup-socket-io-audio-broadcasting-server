/**
 * Seat Domain - Owner Verification
 *
 * Owner caching and verification logic for seat management.
 * Separated from seat.state.ts to keep only owner-related functionality.
 */
import type { AppContext } from "../../context.js";
import { logger } from "../../infrastructure/logger.js";

// ============== Constants ==============

const OWNER_CACHE_TTL_MS = 30_000;
const OWNER_FETCH_TIMEOUT_MS = 5_000;

// ============== Owner Cache ==============

// Owner cache to avoid fetching on every action
const roomOwnerCache = new Map<
  string,
  { ownerId: string; expiresAt: number }
>();

/**
 * Set room owner (called when room is created to avoid Laravel API dependency)
 */
export function setRoomOwner(roomId: string, ownerId: string): void {
  roomOwnerCache.set(roomId, {
    ownerId,
    expiresAt: Date.now() + OWNER_CACHE_TTL_MS * 10, // 5 minutes for manually set owners
  });
}

/**
 * Clear owner cache for a room (called when room is closed)
 */
export function clearRoomOwner(roomId: string): void {
  roomOwnerCache.delete(roomId);
}

// ============== Owner Verification ==============

/**
 * Fetch room owner from cache or Laravel API
 */
export async function fetchRoomOwner(
  roomId: string,
  context: AppContext,
): Promise<string> {
  const cached = roomOwnerCache.get(roomId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.ownerId;
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Authorization timeout")),
      OWNER_FETCH_TIMEOUT_MS,
    );
  });

  const roomMetadata = await Promise.race([
    context.laravelClient.getRoomData(roomId),
    timeoutPromise,
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });

  const ownerId = String(roomMetadata.owner_id);
  roomOwnerCache.set(roomId, { ownerId, expiresAt: now + OWNER_CACHE_TTL_MS });
  return ownerId;
}

/**
 * Verify that a user is the room owner
 */
export async function verifyRoomOwner(
  roomId: string,
  requesterId: string,
  context: AppContext,
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  const startTime = Date.now();
  try {
    logger.info({ roomId, requesterId }, "verifyRoomOwner: starting");
    const ownerId = await fetchRoomOwner(roomId, context);
    const fetchTime = Date.now() - startTime;
    logger.info(
      { roomId, requesterId, ownerId, fetchTimeMs: fetchTime },
      "verifyRoomOwner: fetched owner",
    );

    if (requesterId !== ownerId) {
      logger.warn(
        { roomId, requesterId, ownerId },
        "Unauthorized attempt to perform owner action",
      );
      return { allowed: false, error: "Not authorized" };
    }

    const totalTime = Date.now() - startTime;
    logger.info(
      { roomId, requesterId, totalTimeMs: totalTime },
      "verifyRoomOwner: success",
    );
    return { allowed: true };
  } catch (err) {
    const totalTime = Date.now() - startTime;
    logger.error(
      {
        err,
        roomId,
        requesterId,
        totalTimeMs: totalTime,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      },
      "Failed to verify room ownership",
    );
    return { allowed: false, error: "Authorization check failed" };
  }
}

/**
 * Verify that a user can manage the room (owner OR admin)
 * This is more permissive than verifyRoomOwner and allows admins to perform actions.
 */
export async function verifyRoomManager(
  roomId: string,
  requesterId: string,
  context: AppContext,
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  const startTime = Date.now();
  try {
    logger.info({ roomId, requesterId }, "verifyRoomManager: starting");
    
    // Check if user can manage room (owner or admin)
    const canManage = await context.laravelClient.canManageRoom(roomId, requesterId);
    
    const fetchTime = Date.now() - startTime;
    logger.info(
      { roomId, requesterId, canManage, fetchTimeMs: fetchTime },
      "verifyRoomManager: result",
    );

    if (!canManage) {
      logger.warn(
        { roomId, requesterId },
        "Unauthorized attempt to perform manager action",
      );
      return { allowed: false, error: "Not authorized" };
    }

    return { allowed: true };
  } catch (err) {
    const totalTime = Date.now() - startTime;
    logger.error(
      {
        err,
        roomId,
        requesterId,
        totalTimeMs: totalTime,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      },
      "Failed to verify room manager",
    );
    return { allowed: false, error: "Authorization check failed" };
  }
}
