import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import {
  seatTakeSchema,
  seatLeaveSchema,
  seatAssignSchema,
  seatRemoveSchema,
  seatMuteSchema,
  seatLockSchema,
  seatInviteSchema,
  seatInviteResponseSchema,
} from "../schemas.js";

export interface SeatData {
  userId: string;
  muted: boolean;
}

// In-memory seat storage per room (could be moved to Redis for persistence)
const roomSeats = new Map<string, Map<number, SeatData>>();
// Track locked seats per room (empty locked seats)
const roomLockedSeats = new Map<string, Set<number>>();
// Pending invites per room: Map<roomId, Map<seatIndex, invite>>
interface PendingInvite {
  userId: string;
  seatIndex: number;
  invitedBy: string;
  inviterName: string;
  expiresAt: number;
  timeoutId: NodeJS.Timeout;
}
const pendingInvites = new Map<string, Map<number, PendingInvite>>();
const INVITE_EXPIRY_MS = 30_000;
// Simple owner cache to avoid fetching on every action
const OWNER_CACHE_TTL_MS = 30_000;
const OWNER_FETCH_TIMEOUT_MS = 5_000;
const roomOwnerCache = new Map<
  string,
  { ownerId: string; expiresAt: number }
>();

/**
 * Check if a seat is locked
 */
export function isSeatLocked(roomId: string, seatIndex: number): boolean {
  return roomLockedSeats.get(roomId)?.has(seatIndex) ?? false;
}

/**
 * Get all locked seat indices for a room
 */
export const getLockedSeats = (roomId: string): number[] => {
  const lockedSet = roomLockedSeats.get(roomId);
  return lockedSet ? Array.from(lockedSet) : [];
};

/**
 * Set room owner (called when room is created to avoid Laravel API dependency)
 */
export function setRoomOwner(roomId: string, ownerId: string): void {
  roomOwnerCache.set(roomId, {
    ownerId,
    expiresAt: Date.now() + OWNER_CACHE_TTL_MS * 10, // 5 minutes for manually set owners
  });
}

function getOrCreateRoomSeats(roomId: string): Map<number, SeatData> {
  let seats = roomSeats.get(roomId);
  if (!seats) {
    seats = new Map();
    roomSeats.set(roomId, seats);
  }
  return seats;
}

function findUserSeat(roomId: string, userId: string): number | null {
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

async function fetchRoomOwner(
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

async function verifyRoomOwner(
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

export const seatHandler = (socket: Socket, context: AppContext): void => {
  const userId = String(socket.data.user.id);
  logger.info({ socketId: socket.id, userId }, "seatHandler registered");

  // seat:take - User takes an available seat
  socket.on(
    "seat:take",
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatTakeSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, seatIndex } = result.data;
      const seats = getOrCreateRoomSeats(roomId);

      // Check if seat is locked
      if (isSeatLocked(roomId, seatIndex)) {
        if (callback) callback({ success: false, error: "Seat is locked" });
        return;
      }

      // Check if seat is already taken
      if (seats.has(seatIndex)) {
        if (callback)
          callback({ success: false, error: "Seat is already taken" });
        return;
      }

      // Check if user is already in another seat
      const existingSeat = findUserSeat(roomId, userId);
      if (existingSeat !== null) {
        // Remove from existing seat first
        seats.delete(existingSeat);
        socket.to(roomId).emit("seat:cleared", { seatIndex: existingSeat });
      }

      // Assign user to seat
      seats.set(seatIndex, { userId, muted: false });

      logger.info({ roomId, userId, seatIndex }, "User took seat");

      // Broadcast to room
      const user = socket.data.user;
      const seatUpdate = {
        seatIndex,
        user: {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
        },
        isMuted: false,
      };

      socket.to(roomId).emit("seat:updated", seatUpdate);

      if (callback) callback({ success: true });
    },
  );

  // seat:leave - User leaves their seat
  socket.on(
    "seat:leave",
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatLeaveSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = result.data;
      const seatIndex = findUserSeat(roomId, userId);

      if (seatIndex === null) {
        if (callback) callback({ success: false, error: "You are not seated" });
        return;
      }

      const seats = getOrCreateRoomSeats(roomId);
      seats.delete(seatIndex);

      logger.info({ roomId, userId, seatIndex }, "User left seat");

      // Broadcast to room
      socket.to(roomId).emit("seat:cleared", { seatIndex });

      if (callback) callback({ success: true });
    },
  );

  // seat:assign - Owner assigns user to specific seat
  socket.on(
    "seat:assign",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatAssignSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId, seatIndex } = result.data;
      const seats = getOrCreateRoomSeats(roomId);

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      if (seats.has(seatIndex)) {
        if (callback)
          callback({ success: false, error: "Seat is already taken" });
        return;
      }

      const targetUserIdStr = String(targetUserId);

      // Remove from existing seat if any
      const existingSeat = findUserSeat(roomId, targetUserIdStr);
      if (existingSeat !== null) {
        seats.delete(existingSeat);
        socket.to(roomId).emit("seat:cleared", { seatIndex: existingSeat });
      }

      seats.set(seatIndex, { userId: targetUserIdStr, muted: false });

      logger.info(
        { roomId, targetUserId, seatIndex, assignedBy: userId },
        "User assigned to seat",
      );

      // Broadcast seat update - frontend will look up user info from participants
      socket.to(roomId).emit("seat:updated", {
        seatIndex,
        user: { id: targetUserId },
        isMuted: false,
      });

      if (callback) callback({ success: true });
    },
  );

  // seat:remove - Owner removes user from seat
  socket.on(
    "seat:remove",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatRemoveSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId } = result.data;

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      const targetUserIdStr = String(targetUserId);
      const seatIndex = findUserSeat(roomId, targetUserIdStr);

      if (seatIndex === null) {
        if (callback) callback({ success: false, error: "User is not seated" });
        return;
      }

      const seats = getOrCreateRoomSeats(roomId);
      seats.delete(seatIndex);

      logger.info(
        { roomId, targetUserId, seatIndex, removedBy: userId },
        "User removed from seat",
      );

      socket.to(roomId).emit("seat:cleared", { seatIndex });

      if (callback) callback({ success: true });
    },
  );

  // seat:mute - Owner mutes user
  socket.on(
    "seat:mute",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatMuteSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId } = result.data;

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      const targetUserIdStr = String(targetUserId);
      const seatIndex = findUserSeat(roomId, targetUserIdStr);

      if (seatIndex === null) {
        if (callback) callback({ success: false, error: "User is not seated" });
        return;
      }

      const seats = getOrCreateRoomSeats(roomId);
      const seat = seats.get(seatIndex);
      if (seat) {
        seat.muted = true;
      }

      logger.info(
        { roomId, targetUserId, seatIndex, mutedBy: userId },
        "User muted",
      );

      // Enforce silence on the server side
      const targetClient = context.clientManager
        .getClientsInRoom(roomId)
        .find((c) => String(c.userId) === targetUserIdStr);

      if (targetClient) {
        const audioProducerId = targetClient.producers.get("audio");
        if (audioProducerId) {
          const room = await context.roomManager.getRoom(roomId);
          const producer = room?.getProducer(audioProducerId);
          if (producer) {
            await producer.pause();
            logger.info(
              { roomId, targetUserId, producerId: audioProducerId },
              "Producer paused (server-side mute)",
            );
          }
        }
      }

      socket.to(roomId).emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: true,
      });
      // Also emit to sender so their UI updates
      socket.emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: true,
      });

      if (callback) callback({ success: true });
    },
  );
  // seat:unmute - Owner unmutes user
  socket.on(
    "seat:unmute",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatMuteSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, userId: targetUserId } = result.data;

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      const targetUserIdStr = String(targetUserId);
      const seatIndex = findUserSeat(roomId, targetUserIdStr);

      if (seatIndex === null) {
        if (callback) callback({ success: false, error: "User is not seated" });
        return;
      }

      const seats = getOrCreateRoomSeats(roomId);
      const seat = seats.get(seatIndex);
      if (seat) {
        seat.muted = false;
      }

      logger.info(
        { roomId, targetUserId, seatIndex, unmutedBy: userId },
        "User unmuted",
      );

      // Resume audio on the server side
      const targetClient = context.clientManager
        .getClientsInRoom(roomId)
        .find((c) => String(c.userId) === targetUserIdStr);

      if (targetClient) {
        const audioProducerId = targetClient.producers.get("audio");
        if (audioProducerId) {
          const room = await context.roomManager.getRoom(roomId);
          const producer = room?.getProducer(audioProducerId);
          if (producer) {
            await producer.resume();
            logger.info(
              { roomId, targetUserId, producerId: audioProducerId },
              "Producer resumed (server-side unmute)",
            );
          }
        }
      }

      socket.to(roomId).emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: false,
      });
      // Also emit to sender so their UI updates
      socket.emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: false,
      });

      if (callback) callback({ success: true });
    },
  );

  // seat:lock - Owner locks a seat (kicks user if occupied)
  socket.on(
    "seat:lock",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const startTime = Date.now();
      logger.info({ userId, payload: rawPayload }, "seat:lock received");
      try {
        const result = seatLockSchema.safeParse(rawPayload);
        if (!result.success) {
          logger.warn(
            { userId, error: result.error },
            "seat:lock invalid payload",
          );
          if (callback) callback({ success: false, error: "Invalid payload" });
          return;
        }

        const { roomId, seatIndex } = result.data;
        logger.info(
          { userId, roomId, seatIndex },
          "seat:lock verifying ownership",
        );

        const ownership = await verifyRoomOwner(roomId, userId, context);
        const verifyTime = Date.now() - startTime;
        logger.info(
          {
            userId,
            roomId,
            seatIndex,
            allowed: ownership.allowed,
            verifyTimeMs: verifyTime,
          },
          "seat:lock ownership verified",
        );
        if (!ownership.allowed) {
          if (callback) callback({ success: false, error: ownership.error });
          return;
        }

        // Check if already locked
        if (isSeatLocked(roomId, seatIndex)) {
          if (callback)
            callback({ success: false, error: "Seat is already locked" });
          return;
        }

        const seats = getOrCreateRoomSeats(roomId);
        const existingSeat = seats.get(seatIndex);

        // If someone is on this seat, kick them
        if (existingSeat) {
          seats.delete(seatIndex);
          socket.to(roomId).emit("seat:cleared", { seatIndex });
          // Also emit to self
          socket.emit("seat:cleared", { seatIndex });

          logger.info(
            {
              roomId,
              userId: existingSeat.userId,
              seatIndex,
              lockedBy: userId,
            },
            "User kicked from seat due to lock",
          );
        }

        // Add to locked seats
        let lockedSet = roomLockedSeats.get(roomId);
        if (!lockedSet) {
          lockedSet = new Set();
          roomLockedSeats.set(roomId, lockedSet);
        }
        lockedSet.add(seatIndex);

        logger.info({ roomId, seatIndex, lockedBy: userId }, "Seat locked");

        // Broadcast to all including sender
        const lockEvent = { seatIndex, isLocked: true };
        socket.to(roomId).emit("seat:locked", lockEvent);
        socket.emit("seat:locked", lockEvent);

        const totalTime = Date.now() - startTime;
        logger.info(
          { userId, roomId, seatIndex, totalTimeMs: totalTime },
          "seat:lock success, calling callback",
        );
        if (callback) {
          callback({ success: true });
          logger.info(
            { userId, roomId, seatIndex },
            "seat:lock callback executed",
          );
        } else {
          logger.warn(
            { userId, roomId, seatIndex },
            "seat:lock no callback provided",
          );
        }
      } catch (error) {
        const totalTime = Date.now() - startTime;
        logger.error(
          {
            error,
            userId,
            totalTimeMs: totalTime,
            stack: error instanceof Error ? error.stack : undefined,
          },
          "seat:lock handler exception",
        );
        if (callback) {
          callback({ success: false, error: "Internal server error" });
          logger.info({ userId }, "seat:lock error callback executed");
        }
      }
    },
  );

  // seat:unlock - Owner unlocks a seat
  socket.on(
    "seat:unlock",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatLockSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId, seatIndex } = result.data;

      const ownership = await verifyRoomOwner(roomId, userId, context);
      if (!ownership.allowed) {
        if (callback) callback({ success: false, error: ownership.error });
        return;
      }

      // Check if not locked
      if (!isSeatLocked(roomId, seatIndex)) {
        if (callback) callback({ success: false, error: "Seat is not locked" });
        return;
      }

      // Remove from locked seats
      const lockedSet = roomLockedSeats.get(roomId);
      if (lockedSet) {
        lockedSet.delete(seatIndex);
      }

      logger.info({ roomId, seatIndex, unlockedBy: userId }, "Seat unlocked");

      // Broadcast to all including sender
      const unlockEvent = { seatIndex, isLocked: false };
      socket.to(roomId).emit("seat:locked", unlockEvent);
      socket.emit("seat:locked", unlockEvent);

      if (callback) callback({ success: true });
    },
  );

  // seat:invite - Owner invites user to a seat
  socket.on(
    "seat:invite",
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const startTime = Date.now();
      logger.info({ userId, payload: rawPayload }, "seat:invite received");
      try {
        const result = seatInviteSchema.safeParse(rawPayload);
        if (!result.success) {
          logger.warn(
            { userId, error: result.error },
            "seat:invite invalid payload",
          );
          if (callback) callback({ success: false, error: "Invalid payload" });
          return;
        }

        const { roomId, userId: targetUserId, seatIndex } = result.data;
        logger.info(
          { userId, roomId, targetUserId, seatIndex },
          "seat:invite verifying ownership",
        );

        const ownership = await verifyRoomOwner(roomId, userId, context);
        const verifyTime = Date.now() - startTime;
        logger.info(
          {
            userId,
            roomId,
            targetUserId,
            seatIndex,
            allowed: ownership.allowed,
            verifyTimeMs: verifyTime,
          },
          "seat:invite ownership verified",
        );
        if (!ownership.allowed) {
          if (callback) callback({ success: false, error: ownership.error });
          return;
        }

        const seats = getOrCreateRoomSeats(roomId);

        // Check if seat is occupied
        if (seats.has(seatIndex)) {
          if (callback)
            callback({ success: false, error: "Seat is already occupied" });
          return;
        }

        // Check if seat is locked
        if (isSeatLocked(roomId, seatIndex)) {
          if (callback) callback({ success: false, error: "Seat is locked" });
          return;
        }

        // Check if there's already a pending invite for this seat
        let roomInvites = pendingInvites.get(roomId);
        if (!roomInvites) {
          roomInvites = new Map();
          pendingInvites.set(roomId, roomInvites);
        }

        if (roomInvites.has(seatIndex)) {
          if (callback)
            callback({
              success: false,
              error: "Invite already pending for this seat",
            });
          return;
        }

        const targetUserIdStr = String(targetUserId);
        const expiresAt = Date.now() + INVITE_EXPIRY_MS;

        // Set up auto-expiry
        const timeoutId = setTimeout(() => {
          roomInvites?.delete(seatIndex);
          // Notify target user that invite expired
          socket.to(roomId).emit("seat:invite:expired", { seatIndex });
          logger.info(
            { roomId, seatIndex, targetUserId },
            "Seat invite expired",
          );
        }, INVITE_EXPIRY_MS);

        const inviterUser = socket.data.user;
        roomInvites.set(seatIndex, {
          userId: targetUserIdStr,
          seatIndex,
          invitedBy: userId,
          inviterName: inviterUser.name,
          expiresAt,
          timeoutId,
        });

        logger.info(
          { roomId, targetUserId, seatIndex, invitedBy: userId },
          "User invited to seat",
        );

        // Send invite to target user (they need to be in the room)
        socket.to(roomId).emit("seat:invite:received", {
          seatIndex,
          invitedBy: {
            id: inviterUser.id,
            name: inviterUser.name,
          },
          expiresAt,
          targetUserId,
        });

        const totalTime = Date.now() - startTime;
        logger.info(
          { userId, roomId, targetUserId, seatIndex, totalTimeMs: totalTime },
          "seat:invite success, calling callback",
        );
        if (callback) {
          callback({ success: true });
          logger.info(
            { userId, roomId, targetUserId, seatIndex },
            "seat:invite callback executed",
          );
        } else {
          logger.warn(
            { userId, roomId, targetUserId, seatIndex },
            "seat:invite no callback provided",
          );
        }
      } catch (error) {
        const totalTime = Date.now() - startTime;
        logger.error(
          {
            error,
            userId,
            totalTimeMs: totalTime,
            stack: error instanceof Error ? error.stack : undefined,
          },
          "seat:invite handler exception",
        );
        if (callback) {
          callback({ success: false, error: "Internal server error" });
          logger.info({ userId }, "seat:invite error callback executed");
        }
      }
    },
  );

  // seat:invite:accept - User accepts invite
  socket.on(
    "seat:invite:accept",
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatInviteResponseSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = result.data;
      const roomInvites = pendingInvites.get(roomId);

      // Find invite for this user
      let foundInvite: PendingInvite | undefined;
      let foundSeatIndex: number | undefined;

      if (roomInvites) {
        for (const [seatIndex, invite] of roomInvites) {
          if (invite.userId === userId) {
            foundInvite = invite;
            foundSeatIndex = seatIndex;
            break;
          }
        }
      }

      if (!foundInvite || foundSeatIndex === undefined) {
        if (callback)
          callback({ success: false, error: "No pending invite found" });
        return;
      }

      // Clear the timeout
      clearTimeout(foundInvite.timeoutId);
      roomInvites?.delete(foundSeatIndex);

      const seats = getOrCreateRoomSeats(roomId);

      // Check if seat is still available
      if (seats.has(foundSeatIndex)) {
        if (callback)
          callback({ success: false, error: "Seat is no longer available" });
        return;
      }

      // Remove from existing seat if any
      const existingSeat = findUserSeat(roomId, userId);
      if (existingSeat !== null) {
        seats.delete(existingSeat);
        socket.to(roomId).emit("seat:cleared", { seatIndex: existingSeat });
        socket.emit("seat:cleared", { seatIndex: existingSeat });
      }

      // Assign user to seat
      seats.set(foundSeatIndex, { userId, muted: false });

      logger.info(
        { roomId, userId, seatIndex: foundSeatIndex },
        "User accepted seat invite",
      );

      // Broadcast seat update
      const user = socket.data.user;
      const seatUpdate = {
        seatIndex: foundSeatIndex,
        user: {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
        },
        isMuted: false,
      };

      socket.to(roomId).emit("seat:updated", seatUpdate);
      socket.emit("seat:updated", seatUpdate);

      if (callback) callback({ success: true });
    },
  );

  // seat:invite:decline - User declines invite
  socket.on(
    "seat:invite:decline",
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void,
    ) => {
      const result = seatInviteResponseSchema.safeParse(rawPayload);
      if (!result.success) {
        if (callback) callback({ success: false, error: "Invalid payload" });
        return;
      }

      const { roomId } = result.data;
      const roomInvites = pendingInvites.get(roomId);

      // Find invite for this user
      let foundInvite: PendingInvite | undefined;
      let foundSeatIndex: number | undefined;

      if (roomInvites) {
        for (const [seatIndex, invite] of roomInvites) {
          if (invite.userId === userId) {
            foundInvite = invite;
            foundSeatIndex = seatIndex;
            break;
          }
        }
      }

      if (!foundInvite || foundSeatIndex === undefined) {
        if (callback)
          callback({ success: false, error: "No pending invite found" });
        return;
      }

      // Clear the timeout
      clearTimeout(foundInvite.timeoutId);
      roomInvites?.delete(foundSeatIndex);

      logger.info(
        { roomId, userId, seatIndex: foundSeatIndex },
        "User declined seat invite",
      );

      // Notify owner
      socket.to(roomId).emit("seat:invite:declined", {
        seatIndex: foundSeatIndex,
        userId: parseInt(userId),
      });

      if (callback) callback({ success: true });
    },
  );
};
