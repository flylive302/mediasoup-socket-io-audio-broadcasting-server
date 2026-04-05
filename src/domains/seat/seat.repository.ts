/**
 * Seat Repository — Redis-backed seat management.
 *
 * Core seat operations (take, leave, assign, mute, lock/unlock, query).
 * Invite management is in seat-invite.repository.ts.
 * Lua scripts are in seat.lua-scripts.ts.
 *
 * All seat mutations are atomic Lua scripts via EVALSHA to prevent
 * TOCTOU race conditions.
 */
import type { Redis } from "ioredis";
import type {
  SeatData,
  SeatAssignment,
  SeatActionResult,
} from "./seat.types.js";
import type { PendingInvite } from "./seat.types.js";
import { Errors } from "@src/shared/errors.js";
import { logger } from "@src/infrastructure/logger.js";
import { registerSeatCommands, type RedisWithSeatCommands } from "./seat.lua-scripts.js";
import { SeatInviteRepository } from "./seat-invite.repository.js";

// Re-export for consumers that imported from here
export { SeatInviteRepository } from "./seat-invite.repository.js";

// Redis key patterns
const SEATS_KEY = (roomId: string) => `room:${roomId}:seats`;
const LOCKED_KEY = (roomId: string) => `room:${roomId}:locked_seats`;
// SEAT-005: Reverse index for O(1) user→seat lookups
const USER_SEAT_KEY = (roomId: string, userId: string) =>
  `room:${roomId}:seat:user:${userId}`;

export class SeatRepository {
  private readonly invites: SeatInviteRepository;

  constructor(private readonly redis: Redis) {
    registerSeatCommands(redis);
    this.invites = new SeatInviteRepository(redis);
  }

  /**
   * Atomically take a seat (removes user from any existing seat first)
   */
  async takeSeat(
    roomId: string,
    userId: string,
    seatIndex: number,
    seatCount: number,
  ): Promise<SeatActionResult> {
    try {
      const result = (await (this.redis as never as RedisWithSeatCommands).seatTake(
        SEATS_KEY(roomId),
        LOCKED_KEY(roomId),
        USER_SEAT_KEY(roomId, userId),
        seatIndex.toString(),
        userId,
        seatCount.toString(),
      )) as string;

      const parsed = JSON.parse(result) as SeatActionResult;

      // Map internal error codes to user-facing messages
      if (!parsed.success) {
        parsed.error = this.mapError(parsed.error);
      }

      return parsed;
    } catch (err) {
      logger.error({ err, roomId, userId, seatIndex }, "Failed to take seat");
      return { success: false, error: Errors.INTERNAL_ERROR };
    }
  }

  /**
   * Leave current seat
   */
  async leaveSeat(roomId: string, userId: string): Promise<SeatActionResult> {
    try {
      const result = (await (this.redis as never as RedisWithSeatCommands).seatLeave(
        SEATS_KEY(roomId),
        USER_SEAT_KEY(roomId, userId),
        userId,
      )) as string;

      const parsed = JSON.parse(result) as SeatActionResult;

      if (!parsed.success) {
        parsed.error = this.mapError(parsed.error);
      }

      return parsed;
    } catch (err) {
      logger.error({ err, roomId, userId }, "Failed to leave seat");
      return { success: false, error: Errors.INTERNAL_ERROR };
    }
  }

  /**
   * Assign user to a specific seat (owner action)
   */
  async assignSeat(
    roomId: string,
    userId: string,
    seatIndex: number,
    seatCount: number,
  ): Promise<SeatActionResult> {
    try {
      const result = (await (this.redis as never as RedisWithSeatCommands).seatAssign(
        SEATS_KEY(roomId),
        LOCKED_KEY(roomId),
        USER_SEAT_KEY(roomId, userId),
        seatIndex.toString(),
        userId,
        seatCount.toString(),
        `room:${roomId}:seat:user:`,
      )) as string;

      const parsed = JSON.parse(result) as SeatActionResult;

      if (!parsed.success) {
        parsed.error = this.mapError(parsed.error);
      }

      return parsed;
    } catch (err) {
      logger.error({ err, roomId, userId, seatIndex }, "Failed to assign seat");
      return { success: false, error: Errors.INTERNAL_ERROR };
    }
  }

  /**
   * Remove user from their seat (owner action)
   */
  async removeSeat(roomId: string, userId: string): Promise<SeatActionResult> {
    return this.leaveSeat(roomId, userId);
  }

  /**
   * Set mute status for a seated user
   * BL-003 FIX: Atomic Lua script to prevent TOCTOU race conditions
   */
  async setMute(
    roomId: string,
    seatIndex: number,
    muted: boolean,
  ): Promise<boolean> {
    try {
      const result = await (this.redis as never as RedisWithSeatCommands).seatSetMute(
        SEATS_KEY(roomId),
        seatIndex.toString(),
        muted.toString(),
      );
      return result === 1;
    } catch (err) {
      logger.error({ err, roomId, seatIndex, muted }, "Failed to set mute");
      return false;
    }
  }

  /**
   * Lock a seat (kicks any occupant)
   * BL-005 FIX: Atomic Lua script to prevent HGET → HDEL → SADD race
   */
  async lockSeat(
    roomId: string,
    seatIndex: number,
  ): Promise<SeatActionResult & { kicked?: string | null }> {
    try {
      const result = (await (this.redis as never as RedisWithSeatCommands).seatLock(
        SEATS_KEY(roomId),
        LOCKED_KEY(roomId),
        seatIndex.toString(),
        `room:${roomId}:seat:user:`,
      )) as string;

      const parsed = JSON.parse(result) as {
        success: boolean;
        error?: string;
        kicked?: string | false;
      };

      if (!parsed.success) {
        return { success: false, error: this.mapError(parsed.error ?? "") };
      }

      return {
        success: true,
        seatIndex,
        kicked: parsed.kicked === false ? null : (parsed.kicked ?? null),
      };
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to lock seat");
      return { success: false, error: Errors.INTERNAL_ERROR };
    }
  }

  /**
   * Unlock a seat
   */
  async unlockSeat(
    roomId: string,
    seatIndex: number,
  ): Promise<SeatActionResult> {
    try {
      const result = (await (this.redis as never as RedisWithSeatCommands).seatUnlock(
        LOCKED_KEY(roomId),
        seatIndex.toString(),
      )) as string;

      const parsed = JSON.parse(result) as SeatActionResult;

      if (!parsed.success) {
        parsed.error = this.mapError(parsed.error);
      }

      return parsed;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to unlock seat");
      return { success: false, error: Errors.INTERNAL_ERROR };
    }
  }

  /**
   * Get all seats for a room
   */
  async getSeats(roomId: string, seatCount: number): Promise<SeatData[]> {
    try {
      const [seatsData, lockedSeats] = await Promise.all([
        this.redis.hgetall(SEATS_KEY(roomId)),
        this.redis.smembers(LOCKED_KEY(roomId)),
      ]);

      const lockedSet = new Set(lockedSeats);
      const seats: SeatData[] = [];

      for (let i = 0; i < seatCount; i++) {
        const seatStr = seatsData[i.toString()];
        if (seatStr) {
          const data = JSON.parse(seatStr) as SeatAssignment;
          seats.push({
            index: i,
            userId: data.userId,
            muted: data.muted,
            locked: lockedSet.has(i.toString()),
          });
        } else {
          seats.push({
            index: i,
            userId: null,
            muted: false,
            locked: lockedSet.has(i.toString()),
          });
        }
      }

      return seats;
    } catch (err) {
      logger.error({ err, roomId }, "Failed to get seats");
      return [];
    }
  }

  /**
   * Check if a specific seat is occupied. O(1) HGET lookup.
   * Returns the userId string if occupied, null if empty.
   */
  async getSeatOccupant(roomId: string, seatIndex: number): Promise<string | null> {
    try {
      const seatStr = await this.redis.hget(SEATS_KEY(roomId), seatIndex.toString());
      if (!seatStr) return null;
      const data = JSON.parse(seatStr) as SeatAssignment;
      return data.userId ?? null;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to check seat occupant");
      return null;
    }
  }

  /**
   * Get seat by user ID
   * SEAT-005: O(1) via reverse index instead of O(n) HGETALL scan
   */
  async getUserSeat(roomId: string, userId: string): Promise<number | null> {
    try {
      const seatIndexStr = await this.redis.get(USER_SEAT_KEY(roomId, userId));
      return seatIndexStr ? parseInt(seatIndexStr, 10) : null;
    } catch (err) {
      logger.error({ err, roomId, userId }, "Failed to get user seat");
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Invite Delegation (forwards to SeatInviteRepository)
  // ─────────────────────────────────────────────────────────────────

  async createInvite(
    roomId: string,
    seatIndex: number,
    targetUserId: string,
    invitedBy: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return this.invites.createInvite(roomId, seatIndex, targetUserId, invitedBy, ttlSeconds);
  }

  async getInvite(roomId: string, seatIndex: number): Promise<PendingInvite | null> {
    return this.invites.getInvite(roomId, seatIndex);
  }

  async deleteInvite(roomId: string, seatIndex: number): Promise<boolean> {
    return this.invites.deleteInvite(roomId, seatIndex);
  }

  async getInviteByUser(
    roomId: string,
    targetUserId: string,
  ): Promise<{ invite: PendingInvite; seatIndex: number } | null> {
    return this.invites.getInviteByUser(roomId, targetUserId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Room Cleanup
  // ─────────────────────────────────────────────────────────────────

  /**
   * Clear all seat data for a room.
   * Uses SCAN instead of KEYS to avoid blocking Redis in production.
   * Cleans up: seats hash, locked set, invite keys, and user reverse index keys.
   */
  async clearRoom(roomId: string): Promise<void> {
    try {
      // Scan for invite keys, user invite reverse index keys, AND seat reverse index keys
      const patterns = [
        `room:${roomId}:invite:*`,
        `room:${roomId}:seat:user:*`,
      ];
      const keysToDelete: string[] = [];

      for (const pattern of patterns) {
        let cursor = "0";
        do {
          const [nextCursor, keys] = await this.redis.scan(
            cursor,
            "MATCH",
            pattern,
            "COUNT",
            100,
          );
          cursor = nextCursor;
          keysToDelete.push(...keys);
        } while (cursor !== "0");
      }

      const pipeline = this.redis.pipeline();
      pipeline.del(SEATS_KEY(roomId));
      pipeline.del(LOCKED_KEY(roomId));

      for (const key of keysToDelete) {
        pipeline.del(key);
      }

      await pipeline.exec();
    } catch (err) {
      logger.error({ err, roomId }, "Failed to clear room seats");
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  private mapError(code: string): string {
    switch (code) {
      case "SEAT_INVALID":
        return Errors.SEAT_INVALID;
      case "SEAT_LOCKED":
        return Errors.SEAT_LOCKED;
      case "SEAT_TAKEN":
        return Errors.SEAT_TAKEN;
      case "NOT_SEATED":
        return Errors.NOT_SEATED;
      case "ALREADY_LOCKED":
        return Errors.SEAT_ALREADY_LOCKED;
      case "NOT_LOCKED":
        return Errors.SEAT_NOT_LOCKED;
      default:
        return Errors.INTERNAL_ERROR;
    }
  }
}
