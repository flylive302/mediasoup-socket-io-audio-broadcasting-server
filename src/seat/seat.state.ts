/**
 * Seat Domain State Management
 * In-memory state and helper functions for seat management
 * 
 * NOTE: This uses in-memory state with sticky sessions.
 * For full horizontal scaling, migrate to src/seat/seat.repository.ts (Redis)
 */
import type { AppContext } from "../context.js";
import { logger } from "../core/logger.js";

// ============== Types ==============

export interface SeatData {
  userId: string;
  muted: boolean;
}

export interface PendingInvite {
  userId: string;
  seatIndex: number;
  invitedBy: string;
  inviterName: string;
  expiresAt: number;
  timeoutId: NodeJS.Timeout;
}

// ============== In-Memory State ==============

// Seat assignments per room: Map<roomId, Map<seatIndex, SeatData>>
const roomSeats = new Map<string, Map<number, SeatData>>();

// Locked seats per room: Map<roomId, Set<seatIndex>>
const roomLockedSeats = new Map<string, Set<number>>();

// Pending invites per room: Map<roomId, Map<seatIndex, PendingInvite>>
export const pendingInvites = new Map<string, Map<number, PendingInvite>>();

// Constants
export const INVITE_EXPIRY_MS = 30_000;

// Owner cache to avoid fetching on every action
const OWNER_CACHE_TTL_MS = 30_000;
const OWNER_FETCH_TIMEOUT_MS = 5_000;
const roomOwnerCache = new Map<string, { ownerId: string; expiresAt: number }>();

// ============== Seat State Functions ==============

/**
 * Check if a seat is locked
 */
export function isSeatLocked(roomId: string, seatIndex: number): boolean {
  return roomLockedSeats.get(roomId)?.has(seatIndex) ?? false;
}

/**
 * Get all locked seat indices for a room
 */
export function getLockedSeats(roomId: string): number[] {
  const lockedSet = roomLockedSeats.get(roomId);
  return lockedSet ? Array.from(lockedSet) : [];
}

/**
 * Lock a seat
 */
export function lockSeat(roomId: string, seatIndex: number): void {
  let lockedSet = roomLockedSeats.get(roomId);
  if (!lockedSet) {
    lockedSet = new Set();
    roomLockedSeats.set(roomId, lockedSet);
  }
  lockedSet.add(seatIndex);
}

/**
 * Unlock a seat
 */
export function unlockSeat(roomId: string, seatIndex: number): void {
  const lockedSet = roomLockedSeats.get(roomId);
  if (lockedSet) {
    lockedSet.delete(seatIndex);
  }
}

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
 * Get or create the seats map for a room
 */
export function getOrCreateRoomSeats(roomId: string): Map<number, SeatData> {
  let seats = roomSeats.get(roomId);
  if (!seats) {
    seats = new Map();
    roomSeats.set(roomId, seats);
  }
  return seats;
}

/**
 * Find which seat a user is in
 */
export function findUserSeat(roomId: string, userId: string): number | null {
  const seats = roomSeats.get(roomId);
  if (!seats) return null;

  for (const [index, seat] of seats) {
    if (seat.userId === userId) return index;
  }
  return null;
}

/**
 * Get current seat assignments for a room.
 * Used by roomHandler to send initial state when a user joins.
 */
export function getRoomSeats(
  roomId: string,
): Map<number, SeatData> | undefined {
  return roomSeats.get(roomId);
}

/**
 * Clear a user from their seat in a room.
 * Used when a user leaves or disconnects.
 * @returns The seat index if user was seated, null otherwise
 */
export function clearUserSeat(roomId: string, userId: string): number | null {
  const seatIndex = findUserSeat(roomId, userId);
  if (seatIndex === null) return null;

  const seats = roomSeats.get(roomId);
  if (seats) {
    seats.delete(seatIndex);
  }
  return seatIndex;
}

/**
 * Clear all state for a room (called when room is closed)
 */
export function clearRoomState(roomId: string): void {
  roomSeats.delete(roomId);
  roomLockedSeats.delete(roomId);
  pendingInvites.delete(roomId);
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
