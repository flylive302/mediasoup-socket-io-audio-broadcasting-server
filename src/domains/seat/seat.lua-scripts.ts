/**
 * Seat Lua Scripts — Registered via defineCommand for EVALSHA optimization.
 *
 * All seat mutations are atomic Lua scripts to prevent TOCTOU race conditions.
 * Script text is sent once; subsequent calls use the 40-byte SHA hash.
 *
 * Extracted from seat.repository.ts for maintainability (M-LP-1).
 */
import type { Redis } from "ioredis";

// M-3 FIX: TTL for seat Redis keys — safety net if clearRoom() is never called (e.g. server crash)
export const SEAT_KEY_TTL_SECONDS = 86400; // 24 hours, matches RoomStateRepository.TTL

// ─────────────────────────────────────────────────────────────────
// Scripts
// ─────────────────────────────────────────────────────────────────

export const TAKE_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local lockedKey = KEYS[2]
  local userSeatKey = KEYS[3]
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

  -- Remove user from any existing seat first (O(1) via reverse index).
  -- Capture the prior index so the handler can broadcast seat:cleared
  -- to keep other clients' UIs in sync during a move.
  local previousSeatIndex = redis.call('GET', userSeatKey)
  if previousSeatIndex then
    redis.call('HDEL', seatsKey, previousSeatIndex)
  end

  -- Take the new seat
  local seatData = cjson.encode({userId = userId, muted = false})
  redis.call('HSET', seatsKey, tostring(seatIndex), seatData)

  -- SEAT-005: Maintain user→seat reverse index
  redis.call('SET', userSeatKey, tostring(seatIndex))

  -- M-3 FIX: Ensure TTL on seat keys as crash safety net
  redis.call('EXPIRE', seatsKey, ${SEAT_KEY_TTL_SECONDS})
  redis.call('EXPIRE', userSeatKey, ${SEAT_KEY_TTL_SECONDS})

  if previousSeatIndex then
    return cjson.encode({success = true, seatIndex = seatIndex, previousSeatIndex = tonumber(previousSeatIndex)})
  end
  return cjson.encode({success = true, seatIndex = seatIndex})
`;

export const LEAVE_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local userSeatKey = KEYS[2]
  local userId = ARGV[1]
  
  -- P-4 FIX: O(1) lookup via reverse index instead of HGETALL linear scan
  local seatIndex = redis.call('GET', userSeatKey)
  if not seatIndex then
    return cjson.encode({success = false, error = "NOT_SEATED"})
  end
  
  -- Verify the seat actually belongs to this user (defensive)
  local seatData = redis.call('HGET', seatsKey, seatIndex)
  if seatData then
    local data = cjson.decode(seatData)
    if data.userId == userId then
      redis.call('HDEL', seatsKey, seatIndex)
    end
  end
  
  redis.call('DEL', userSeatKey)
  return cjson.encode({success = true, seatIndex = tonumber(seatIndex)})
`;

export const ASSIGN_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local lockedKey = KEYS[2]
  local userSeatKey = KEYS[3]
  local seatIndex = tonumber(ARGV[1])
  local userId = ARGV[2]
  local seatCount = tonumber(ARGV[3])
  local roomPrefix = ARGV[4]

  -- Validate seat index
  if seatIndex < 0 or seatIndex >= seatCount then
    return cjson.encode({success = false, error = "SEAT_INVALID"})
  end

  -- Check if locked
  if redis.call('SISMEMBER', lockedKey, tostring(seatIndex)) == 1 then
    return cjson.encode({success = false, error = "SEAT_LOCKED"})
  end

  -- Remove anyone currently on that seat + clean their reverse index
  local displaced = redis.call('HGET', seatsKey, tostring(seatIndex))
  if displaced then
    local displacedUser = cjson.decode(displaced).userId
    redis.call('HDEL', seatsKey, tostring(seatIndex))
    redis.call('DEL', roomPrefix .. displacedUser)
  end

  -- Remove user from any existing seat (O(1) via reverse index).
  -- Capture the prior index so the handler can broadcast seat:cleared
  -- to keep other clients' UIs in sync during a move.
  local previousSeatIndex = redis.call('GET', userSeatKey)
  if previousSeatIndex then
    redis.call('HDEL', seatsKey, previousSeatIndex)
  end

  -- Assign user to the seat
  local seatData = cjson.encode({userId = userId, muted = false})
  redis.call('HSET', seatsKey, tostring(seatIndex), seatData)

  -- SEAT-005: Maintain user→seat reverse index
  redis.call('SET', userSeatKey, tostring(seatIndex))

  -- M-3 FIX: Ensure TTL on seat keys as crash safety net
  redis.call('EXPIRE', seatsKey, ${SEAT_KEY_TTL_SECONDS})
  redis.call('EXPIRE', userSeatKey, ${SEAT_KEY_TTL_SECONDS})

  if previousSeatIndex then
    return cjson.encode({success = true, seatIndex = seatIndex, previousSeatIndex = tonumber(previousSeatIndex)})
  end
  return cjson.encode({success = true, seatIndex = seatIndex})
`;

export const SET_MUTE_SCRIPT = `
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

export const LOCK_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local lockedKey = KEYS[2]
  local seatIndex = ARGV[1]
  local roomPrefix = ARGV[2]
  
  -- SEAT-001 FIX: Atomic check inside Lua — eliminates TOCTOU race
  if redis.call('SISMEMBER', lockedKey, seatIndex) == 1 then
    return cjson.encode({success = false, error = "ALREADY_LOCKED"})
  end
  
  local kicked = false
  local existing = redis.call('HGET', seatsKey, seatIndex)
  if existing then
    kicked = cjson.decode(existing).userId
    redis.call('HDEL', seatsKey, seatIndex)
    -- Clean up kicked user's reverse index
    redis.call('DEL', roomPrefix .. kicked)
  end
  redis.call('SADD', lockedKey, seatIndex)
  -- M-3 FIX: Ensure TTL on lock keys
  redis.call('EXPIRE', lockedKey, ${SEAT_KEY_TTL_SECONDS})
  if kicked then
    return cjson.encode({success = true, kicked = kicked})
  end
  return cjson.encode({success = true, kicked = false})
`;

// SEAT-002 FIX: Atomic unlock — check + remove in single EVALSHA
export const UNLOCK_SEAT_SCRIPT = `
  local lockedKey = KEYS[1]
  local seatIndex = ARGV[1]
  if redis.call('SISMEMBER', lockedKey, seatIndex) == 0 then
    return cjson.encode({success = false, error = "NOT_LOCKED"})
  end
  redis.call('SREM', lockedKey, seatIndex)
  return cjson.encode({success = true})
`;

// ─────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────

/**
 * Register all Lua scripts as custom commands on the Redis instance.
 * This enables EVALSHA optimization — full script text is only sent once,
 * subsequent calls use the 40-byte SHA hash.
 */
export function registerSeatCommands(redis: Redis): void {
  redis.defineCommand("seatTake", {
    numberOfKeys: 3,
    lua: TAKE_SEAT_SCRIPT,
  });
  redis.defineCommand("seatLeave", {
    numberOfKeys: 2,
    lua: LEAVE_SEAT_SCRIPT,
  });
  redis.defineCommand("seatAssign", {
    numberOfKeys: 3,
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
  redis.defineCommand("seatUnlock", {
    numberOfKeys: 1,
    lua: UNLOCK_SEAT_SCRIPT,
  });
}

/**
 * Type augmentation for custom Lua commands registered via defineCommand.
 * These methods are dynamically added to the Redis instance at runtime.
 */
export interface RedisWithSeatCommands {
  seatTake(...args: string[]): Promise<string>;
  seatLeave(...args: string[]): Promise<string>;
  seatAssign(...args: string[]): Promise<string>;
  seatSetMute(...args: string[]): Promise<number>;
  seatLock(...args: string[]): Promise<string>;
  seatUnlock(...args: string[]): Promise<string>;
}
