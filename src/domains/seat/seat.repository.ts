/**
 * Seat Repository - Redis-backed seat management
 * Handles all seat state in Redis for horizontal scaling support
 *
 * All Lua scripts are registered via defineCommand() which uses EVALSHA
 * under the hood — only the SHA hash is sent over the wire after the
 * first invocation, not the full script text.
 */
import type { Redis } from "ioredis";
import type {
  SeatData,
  SeatAssignment,
  PendingInvite,
  SeatActionResult,
} from "./seat.types.js";
import { Errors } from "@src/shared/errors.js";
import { logger } from "@src/infrastructure/logger.js";

// Redis key patterns
const SEATS_KEY = (roomId: string) => `room:${roomId}:seats`;
const LOCKED_KEY = (roomId: string) => `room:${roomId}:locked_seats`;
const INVITE_KEY = (roomId: string, seatIndex: number) =>
  `room:${roomId}:invite:${seatIndex}`;
const INVITE_USER_KEY = (roomId: string, userId: string) =>
  `room:${roomId}:invite:user:${userId}`;

// ─────────────────────────────────────────────────────────────────
// Lua Scripts (registered via defineCommand for auto EVALSHA)
// ─────────────────────────────────────────────────────────────────

const TAKE_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local lockedKey = KEYS[2]
  local seatIndex = tonumber(ARGV[1])
  local userId = ARGV[2]
  local seatCount = tonumber(ARGV[3])
  
  -- Validate seat index
  if seatIndex < 0 or seatIndex >= seatCount then
    return cjson.encode({success = false, error = "SEAT_INVALID"})
  end
  
  -- Check if locked
  if redis.call('SISMEMBER', lockedKey, tostring(seatIndex)) == 1 then
    return cjson.encode({success = false, error = "SEAT_LOCKED"})
  end
  
  -- Check if seat is already taken
  local existingSeat = redis.call('HGET', seatsKey, tostring(seatIndex))
  if existingSeat then
    return cjson.encode({success = false, error = "SEAT_TAKEN"})
  end
  
  -- Remove user from any existing seat first
  local allSeats = redis.call('HGETALL', seatsKey)
  for i = 1, #allSeats, 2 do
    local currentIndex = allSeats[i]
    local data = cjson.decode(allSeats[i + 1])
    if data.userId == userId then
      redis.call('HDEL', seatsKey, currentIndex)
    end
  end
  
  -- Take the new seat
  local seatData = cjson.encode({userId = userId, muted = false})
  redis.call('HSET', seatsKey, tostring(seatIndex), seatData)
  
  return cjson.encode({success = true, seatIndex = seatIndex})
`;

const LEAVE_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local userId = ARGV[1]
  
  -- Find and remove user's seat
  local allSeats = redis.call('HGETALL', seatsKey)
  for i = 1, #allSeats, 2 do
    local currentIndex = allSeats[i]
    local data = cjson.decode(allSeats[i + 1])
    if data.userId == userId then
      redis.call('HDEL', seatsKey, currentIndex)
      return cjson.encode({success = true, seatIndex = tonumber(currentIndex)})
    end
  end
  
  return cjson.encode({success = false, error = "NOT_SEATED"})
`;

const ASSIGN_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local lockedKey = KEYS[2]
  local seatIndex = tonumber(ARGV[1])
  local userId = ARGV[2]
  local seatCount = tonumber(ARGV[3])
  
  -- Validate seat index
  if seatIndex < 0 or seatIndex >= seatCount then
    return cjson.encode({success = false, error = "SEAT_INVALID"})
  end
  
  -- Check if locked
  if redis.call('SISMEMBER', lockedKey, tostring(seatIndex)) == 1 then
    return cjson.encode({success = false, error = "SEAT_LOCKED"})
  end
  
  -- Remove anyone currently on that seat
  redis.call('HDEL', seatsKey, tostring(seatIndex))
  
  -- Remove user from any existing seat
  local allSeats = redis.call('HGETALL', seatsKey)
  for i = 1, #allSeats, 2 do
    local currentIndex = allSeats[i]
    local data = cjson.decode(allSeats[i + 1])
    if data.userId == userId then
      redis.call('HDEL', seatsKey, currentIndex)
    end
  end
  
  -- Assign user to the seat
  local seatData = cjson.encode({userId = userId, muted = false})
  redis.call('HSET', seatsKey, tostring(seatIndex), seatData)
  
  return cjson.encode({success = true, seatIndex = seatIndex})
`;

const SET_MUTE_SCRIPT = `
  local key = KEYS[1]
  local seatIndex = ARGV[1]
  local muted = ARGV[2] == "true"
  local existing = redis.call('HGET', key, seatIndex)
  if not existing then return 0 end
  local data = cjson.decode(existing)
  data.muted = muted
  redis.call('HSET', key, seatIndex, cjson.encode(data))
  return 1
`;

const LOCK_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local lockedKey = KEYS[2]
  local seatIndex = ARGV[1]
  local kicked = false
  local existing = redis.call('HGET', seatsKey, seatIndex)
  if existing then
    kicked = cjson.decode(existing).userId
    redis.call('HDEL', seatsKey, seatIndex)
  end
  redis.call('SADD', lockedKey, seatIndex)
  if kicked then
    return cjson.encode({kicked = kicked})
  end
  return cjson.encode({kicked = false})
`;

/**
 * Register all Lua scripts as custom commands on the Redis instance.
 * This enables EVALSHA optimization — full script text is only sent once,
 * subsequent calls use the 40-byte SHA hash.
 */
function registerCommands(redis: Redis): void {
  redis.defineCommand("seatTake", {
    numberOfKeys: 2,
    lua: TAKE_SEAT_SCRIPT,
  });
  redis.defineCommand("seatLeave", {
    numberOfKeys: 1,
    lua: LEAVE_SEAT_SCRIPT,
  });
  redis.defineCommand("seatAssign", {
    numberOfKeys: 2,
    lua: ASSIGN_SEAT_SCRIPT,
  });
  redis.defineCommand("seatSetMute", {
    numberOfKeys: 1,
    lua: SET_MUTE_SCRIPT,
  });
  redis.defineCommand("seatLock", {
    numberOfKeys: 2,
    lua: LOCK_SEAT_SCRIPT,
  });
}

export class SeatRepository {
  constructor(private readonly redis: Redis) {
    registerCommands(redis);
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
      const result = (await (this.redis as never as RedisWithCommands).seatTake(
        SEATS_KEY(roomId),
        LOCKED_KEY(roomId),
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
      const result = (await (this.redis as never as RedisWithCommands).seatLeave(
        SEATS_KEY(roomId),
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
      const result = (await (this.redis as never as RedisWithCommands).seatAssign(
        SEATS_KEY(roomId),
        LOCKED_KEY(roomId),
        seatIndex.toString(),
        userId,
        seatCount.toString(),
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
      const result = await (this.redis as never as RedisWithCommands).seatSetMute(
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
  ): Promise<{ kicked: string | null }> {
    try {
      const result = (await (this.redis as never as RedisWithCommands).seatLock(
        SEATS_KEY(roomId),
        LOCKED_KEY(roomId),
        seatIndex.toString(),
      )) as string;

      const parsed = JSON.parse(result) as { kicked: string | false };
      return { kicked: parsed.kicked === false ? null : parsed.kicked };
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to lock seat");
      return { kicked: null };
    }
  }

  /**
   * Unlock a seat
   */
  async unlockSeat(roomId: string, seatIndex: number): Promise<boolean> {
    try {
      await this.redis.srem(LOCKED_KEY(roomId), seatIndex.toString());
      return true;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to unlock seat");
      return false;
    }
  }

  /**
   * Check if a seat is locked
   */
  async isSeatLocked(roomId: string, seatIndex: number): Promise<boolean> {
    const result = await this.redis.sismember(
      LOCKED_KEY(roomId),
      seatIndex.toString(),
    );
    return result === 1;
  }

  /**
   * Get all locked seats for a room
   */
  async getLockedSeats(roomId: string): Promise<number[]> {
    const locked = await this.redis.smembers(LOCKED_KEY(roomId));
    return locked.map((s) => parseInt(s, 10));
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
   * Get seat data for a specific seat
   */
  async getSeat(roomId: string, seatIndex: number): Promise<SeatData | null> {
    try {
      const [seatStr, isLocked] = await Promise.all([
        this.redis.hget(SEATS_KEY(roomId), seatIndex.toString()),
        this.redis.sismember(LOCKED_KEY(roomId), seatIndex.toString()),
      ]);

      if (seatStr) {
        const data = JSON.parse(seatStr) as SeatAssignment;
        return {
          index: seatIndex,
          userId: data.userId,
          muted: data.muted,
          locked: isLocked === 1,
        };
      }

      return {
        index: seatIndex,
        userId: null,
        muted: false,
        locked: isLocked === 1,
      };
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to get seat");
      return null;
    }
  }

  /**
   * Get seat by user ID
   */
  async getUserSeat(roomId: string, userId: string): Promise<number | null> {
    try {
      const seatsData = await this.redis.hgetall(SEATS_KEY(roomId));

      for (const [index, seatStr] of Object.entries(seatsData)) {
        const data = JSON.parse(seatStr) as SeatAssignment;
        if (data.userId === userId) {
          return parseInt(index, 10);
        }
      }

      return null;
    } catch (err) {
      logger.error({ err, roomId, userId }, "Failed to get user seat");
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Invite Management (with reverse index for O(1) user lookup)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Create a seat invite with TTL.
   * Writes both the invite data key and a reverse index for O(1) user lookup.
   */
  async createInvite(
    roomId: string,
    seatIndex: number,
    targetUserId: string,
    invitedBy: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const invite: PendingInvite = {
        targetUserId,
        invitedBy,
        seatIndex,
        createdAt: Date.now(),
      };

      const pipeline = this.redis.pipeline();
      pipeline.setex(
        INVITE_KEY(roomId, seatIndex),
        ttlSeconds,
        JSON.stringify(invite),
      );
      pipeline.setex(
        INVITE_USER_KEY(roomId, targetUserId),
        ttlSeconds,
        seatIndex.toString(),
      );
      await pipeline.exec();

      return true;
    } catch (err) {
      logger.error(
        { err, roomId, seatIndex, targetUserId },
        "Failed to create invite",
      );
      return false;
    }
  }

  /**
   * Get pending invite for a seat
   */
  async getInvite(
    roomId: string,
    seatIndex: number,
  ): Promise<PendingInvite | null> {
    try {
      const data = await this.redis.get(INVITE_KEY(roomId, seatIndex));
      return data ? (JSON.parse(data) as PendingInvite) : null;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to get invite");
      return null;
    }
  }

  /**
   * Delete a pending invite and its reverse index.
   * Reads the invite first to resolve the targetUserId for reverse index cleanup.
   */
  async deleteInvite(roomId: string, seatIndex: number): Promise<boolean> {
    try {
      // Read invite to get targetUserId for reverse index cleanup
      const data = await this.redis.get(INVITE_KEY(roomId, seatIndex));
      const pipeline = this.redis.pipeline();
      pipeline.del(INVITE_KEY(roomId, seatIndex));

      if (data) {
        const invite = JSON.parse(data) as PendingInvite;
        pipeline.del(INVITE_USER_KEY(roomId, invite.targetUserId));
      }

      await pipeline.exec();
      return true;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to delete invite");
      return false;
    }
  }

  /**
   * O(1) invite lookup by target user ID via reverse index.
   * Returns the invite data and seat index, or null if no invite exists.
   */
  async getInviteByUser(
    roomId: string,
    targetUserId: string,
  ): Promise<{ invite: PendingInvite; seatIndex: number } | null> {
    try {
      // Reverse index: room:{roomId}:invite:user:{userId} → seatIndex
      const seatIndexStr = await this.redis.get(
        INVITE_USER_KEY(roomId, targetUserId),
      );
      if (!seatIndexStr) return null;

      const seatIndex = parseInt(seatIndexStr, 10);
      const invite = await this.getInvite(roomId, seatIndex);
      if (!invite || invite.targetUserId !== targetUserId) return null;

      return { invite, seatIndex };
    } catch (err) {
      logger.error(
        { err, roomId, targetUserId },
        "Failed to get invite by user",
      );
      return null;
    }
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
      // Scan for both invite keys and user reverse index keys
      const pattern = `room:${roomId}:invite:*`;
      const keysToDelete: string[] = [];
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
      default:
        return Errors.INTERNAL_ERROR;
    }
  }
}

/**
 * Type augmentation for custom Lua commands registered via defineCommand.
 * These methods are dynamically added to the Redis instance at runtime.
 */
interface RedisWithCommands {
  seatTake(...args: string[]): Promise<string>;
  seatLeave(...args: string[]): Promise<string>;
  seatAssign(...args: string[]): Promise<string>;
  seatSetMute(...args: string[]): Promise<number>;
  seatLock(...args: string[]): Promise<string>;
}
