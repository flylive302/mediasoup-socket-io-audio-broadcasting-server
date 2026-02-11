/**
 * Seat Domain - Owner Verification
 *
 * Owner caching and verification logic for seat management.
 * Separated from seat.state.ts to keep only owner-related functionality.
 */
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";

// ============== Constants ==============

const OWNER_CACHE_TTL_MS = 30_000;
const OWNER_BOOTSTRAP_TTL_MS = 300_000; // 5 minutes — for owners set at room creation
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
    expiresAt: Date.now() + OWNER_BOOTSTRAP_TTL_MS,
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

// ============== Authorization Result Type ==============

type AuthResult = { allowed: true } | { allowed: false; error: string };

/**
 * Shared authorization check pattern — DRY extraction of timing, logging, and error wrapping
 */
async function withAuthCheck(
  checkFn: () => Promise<boolean>,
  roomId: string,
  requesterId: string,
  actionName: string,
): Promise<AuthResult> {
  const startTime = Date.now();
  try {
    logger.info({ roomId, requesterId }, `${actionName}: starting`);
    const allowed = await checkFn();
    const elapsed = Date.now() - startTime;
    logger.info({ roomId, requesterId, allowed, elapsedMs: elapsed }, `${actionName}: result`);

    if (!allowed) {
      logger.warn({ roomId, requesterId }, `Unauthorized: ${actionName}`);
      return { allowed: false, error: Errors.NOT_AUTHORIZED };
    }
    return { allowed: true };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(
      {
        err,
        roomId,
        requesterId,
        elapsedMs: elapsed,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      },
      `${actionName}: failed`,
    );
    return { allowed: false, error: Errors.AUTH_CHECK_FAILED };
  }
}

// ============== Public Verification Functions ==============

/**
 * Verify that a user is the room owner
 */
export function verifyRoomOwner(
  roomId: string,
  requesterId: string,
  context: AppContext,
): Promise<AuthResult> {
  return withAuthCheck(
    async () => {
      const ownerId = await fetchRoomOwner(roomId, context);
      return requesterId === ownerId;
    },
    roomId,
    requesterId,
    "verifyRoomOwner",
  );
}

/**
 * Verify that a user can manage the room (owner OR admin)
 * More permissive than verifyRoomOwner — allows admins to perform actions.
 */
export function verifyRoomManager(
  roomId: string,
  requesterId: string,
  context: AppContext,
): Promise<AuthResult> {
  return withAuthCheck(
    () => context.laravelClient.canManageRoom(roomId, requesterId),
    roomId,
    requesterId,
    "verifyRoomManager",
  );
}

