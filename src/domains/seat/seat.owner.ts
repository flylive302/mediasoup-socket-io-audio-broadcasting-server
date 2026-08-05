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

// SEAT-004 FIX: Periodic cache pruning — evict expired entries every 60s
const CACHE_PRUNE_INTERVAL_MS = 60_000;
const pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [roomId, entry] of roomOwnerCache) {
    if (entry.expiresAt <= now) roomOwnerCache.delete(roomId);
  }
}, CACHE_PRUNE_INTERVAL_MS);
pruneInterval.unref(); // Don't block process exit

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
  extra: Record<string, unknown> = {},
): Promise<AuthResult> {
  const startTime = Date.now();
  try {
    logger.info({ roomId, requesterId, ...extra }, `${actionName}: starting`);
    const allowed = await checkFn();
    const elapsed = Date.now() - startTime;
    logger.info({ roomId, requesterId, ...extra, allowed, elapsedMs: elapsed }, `${actionName}: result`);

    if (!allowed) {
      logger.warn({ roomId, requesterId, ...extra }, `Unauthorized: ${actionName}`);
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
        ...extra,
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
//
// SEAT-012: Auth Policy Documentation
// Three tiers of authorization are intentionally maintained:
//
// 1. verifyRoomOwner (strict) — Owner-only actions:
//    - assign-seat, remove-seat, audioPlayer:takeover
//    - These alter the room's seating arrangement and should only be done by the room creator.
//
// 2. verifyRoomManager (permissive) — Owner OR Admin, no victim:
//    - unlock-seat, invite, audioPlayer:play
//    - Answers only "may this user moderate at all". Correct for actions that
//      change a slot or the room, not a specific person.
//
// 3. verifyRoomModerationTarget (hierarchical) — Owner OR Admin, WITH a victim:
//    - mute, unmute, lock-seat when the seat is occupied
//    - Also enforces rank: an admin may act on plain members only, never on the
//      owner and never on a peer admin. `verifyRoomManager` cannot express this
//      because it never looks at who is being acted upon — which is exactly how
//      an admin was able to mute the room owner out of their own room.
//
// Do NOT merge these. The distinction is a deliberate security boundary. When
// adding a handler, the question that picks the tier is: *does this action have
// a victim?* If yes, it belongs in tier 3, not tier 2.

/**
 * Verify that a user is the room owner (strict tier).
 * Used for structural actions: lock/unlock/assign seats.
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
 * Verify that a user can manage the room — owner OR admin (permissive tier).
 * Used for moderation actions with no specific victim: unlock/invite/play.
 * More permissive than verifyRoomOwner — allows admins to perform actions.
 *
 * ⚠️ Does NOT look at who is being acted on. If the action targets a person,
 * use `verifyRoomModerationTarget` instead.
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

/**
 * Verify a moderation action that targets a specific user (hierarchical tier).
 *
 *   Owner  → may act on anyone
 *   Admin  → may act on plain members ONLY — never the owner, never a peer admin
 *   Member → may act on nobody
 *
 * Mirrors the Laravel authority (`RoomMemberService::blockMember` + `RoomPolicy`),
 * so MSAB and the REST API agree on one hierarchy.
 *
 * Failure posture, deliberately asymmetric:
 * - Owner identity comes from `fetchRoomOwner`, which THROWS if Laravel is
 *   unreachable → `AUTH_CHECK_FAILED` → denied. Protecting the owner fails CLOSED.
 * - Peer-admin rank comes from `getMemberRole`, which degrades to `null` on error.
 *   A Laravel outage therefore lets one admin act on another. That is the lesser
 *   evil: making it fail closed would break all admin moderation during an outage,
 *   and the owner — the case that actually caused an incident — stays protected.
 */
export function verifyRoomModerationTarget(
  roomId: string,
  requesterId: string,
  targetId: string,
  context: AppContext,
): Promise<AuthResult> {
  return withAuthCheck(
    async () => {
      const ownerId = await fetchRoomOwner(roomId, context);

      // The owner outranks everyone; nothing below can constrain them.
      if (requesterId === ownerId) {
        return true;
      }

      // Everyone else needs at least admin to moderate at all.
      const isManager = await context.laravelClient.canManageRoom(
        roomId,
        requesterId,
      );
      if (!isManager) {
        return false;
      }

      // You always outrank yourself. Without this an admin muted by the owner
      // would be stuck: no peer admin may act on them, so if the owner went
      // offline they could never get their voice back. This is also exactly the
      // pre-hierarchy behaviour — self-actions were always permitted — so it
      // opens no path that was not already open.
      if (requesterId === targetId) {
        return true;
      }

      // Requester is an admin. The owner is untouchable — check by room
      // ownership, NOT by membership role: the owner has no `room_members`
      // row at all, so a role lookup returns null and reads as "plain member".
      if (targetId === ownerId) {
        return false;
      }

      // ...and so is a peer admin. A null role means the target holds no
      // membership row — a plain visitor, who an admin may act on.
      const targetRole = await context.laravelClient.getMemberRole(
        roomId,
        targetId,
      );
      return targetRole !== "admin" && targetRole !== "owner";
    },
    roomId,
    requesterId,
    "verifyRoomModerationTarget",
    { targetId },
  );
}

