import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import {
  seatTakeSchema,
  seatLeaveSchema,
  seatAssignSchema,
  seatRemoveSchema,
  seatMuteSchema,
} from "../schemas.js";

export interface SeatData {
  userId: string;
  muted: boolean;
}

// In-memory seat storage per room (could be moved to Redis for persistence)
const roomSeats = new Map<string, Map<number, SeatData>>();

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

export const seatHandler = (socket: Socket, context: AppContext): void => {
  const userId = String(socket.data.user.id);

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

      try {
        // Fetch room owner to verify authorization
        const roomMetadata = await context.laravelClient.getRoomData(roomId);
        const ownerId = String(roomMetadata.owner_id);

        if (userId !== ownerId) {
          logger.warn(
            { roomId, userId, ownerId },
            "Unauthorized attempt to assign seat",
          );
          if (callback) callback({ success: false, error: "Not authorized" });
          return;
        }
      } catch (err) {
        logger.error(
          { err, roomId, userId },
          "Failed to verify room ownership during seat assignment",
        );
        if (callback)
          callback({ success: false, error: "Authorization check failed" });
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

      try {
        // Fetch room owner to verify authorization
        const roomMetadata = await context.laravelClient.getRoomData(roomId);
        const ownerId = String(roomMetadata.owner_id);

        if (userId !== ownerId) {
          logger.warn(
            { roomId, userId, ownerId },
            "Unauthorized attempt to remove seat",
          );
          if (callback) callback({ success: false, error: "Not authorized" });
          return;
        }
      } catch (err) {
        logger.error(
          { err, roomId, userId },
          "Failed to verify room ownership during seat removal",
        );
        if (callback)
          callback({ success: false, error: "Authorization check failed" });
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

      try {
        const roomMetadata = await context.laravelClient.getRoomData(roomId);
        const ownerId = String(roomMetadata.owner_id);

        if (userId !== ownerId) {
          logger.warn(
            { roomId, userId, ownerId },
            "Unauthorized attempt to mute user",
          );
          if (callback) callback({ success: false, error: "Not authorized" });
          return;
        }
      } catch (err) {
        logger.error(
          { err, roomId, userId },
          "Failed to verify room ownership during mute",
        );
        if (callback)
          callback({ success: false, error: "Authorization check failed" });
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

      socket.to(roomId).emit("seat:userMuted", {
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

      try {
        const roomMetadata = await context.laravelClient.getRoomData(roomId);
        const ownerId = String(roomMetadata.owner_id);

        if (userId !== ownerId) {
          logger.warn(
            { roomId, userId, ownerId },
            "Unauthorized attempt to unmute user",
          );
          if (callback) callback({ success: false, error: "Not authorized" });
          return;
        }
      } catch (err) {
        logger.error(
          { err, roomId, userId },
          "Failed to verify room ownership during unmute",
        );
        if (callback)
          callback({ success: false, error: "Authorization check failed" });
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

      socket.to(roomId).emit("seat:userMuted", {
        userId: targetUserId,
        isMuted: false,
      });

      if (callback) callback({ success: true });
    },
  );
};
