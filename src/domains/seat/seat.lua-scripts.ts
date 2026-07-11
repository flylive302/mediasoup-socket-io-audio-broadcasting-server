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

  -- F-41: Single-occupancy heal. Remove this user from EVERY seat they hold,
  -- not just the reverse-index one. The per-user reverse index (userSeatKey)
  -- can expire or desync while the shared seats hash — re-EXPIRE'd by ANY
  -- user's take, so effectively immortal in an active room — still holds this
  -- user's entry. Relying on GET userSeatKey alone (the old behaviour) then
  -- skipped the HDEL and let the same user accumulate ghosts across seats,
  -- each reading as SEAT_TAKEN forever. A bounded HGETALL scan (<= seatCount
  -- entries, atomic in this EVALSHA) clears them all and self-heals corrupted
  -- rooms on the user's next move. Returns every vacated index so the handler
  -- can broadcast seat:cleared for each, keeping observers in sync.
  local cleared = {}
  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local ok, data = pcall(cjson.decode, all[i + 1])
    if ok and tostring(data.userId) == tostring(userId) and idx ~= tostring(seatIndex) then
      redis.call('HDEL', seatsKey, idx)
      table.insert(cleared, tonumber(idx))
    end
  end

  -- Take the new seat
  local seatData = cjson.encode({userId = userId, muted = false})
  redis.call('HSET', seatsKey, tostring(seatIndex), seatData)

  -- SEAT-005: Maintain user→seat reverse index
  redis.call('SET', userSeatKey, tostring(seatIndex))

  -- M-3 FIX: Ensure TTL on seat keys as crash safety net
  redis.call('EXPIRE', seatsKey, ${SEAT_KEY_TTL_SECONDS})
  redis.call('EXPIRE', userSeatKey, ${SEAT_KEY_TTL_SECONDS})

  local resp = {success = true, seatIndex = seatIndex}
  if #cleared > 0 then resp.clearedSeatIndices = cleared end
  return cjson.encode(resp)
`;

export const LEAVE_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local userSeatKey = KEYS[2]
  local userId = ARGV[1]

  -- F-41 (supersedes the F-38 single-match fallback): always remove the user
  -- from EVERY seat they hold via a bounded HGETALL scan, not just the one the
  -- reverse index points at. The per-user reverse index can expire or desync
  -- while the shared seats hash (kept alive by any user's take) still holds
  -- this user's entries, so a single reverse-index lookup can leave orphaned
  -- ghosts behind. Scanning the bounded hash (<= seatCount entries) clears them
  -- all atomically in this one EVALSHA. Returns every vacated index so leave /
  -- disconnect / kick can broadcast a seat:cleared per slot.
  local cleared = {}
  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local ok, data = pcall(cjson.decode, all[i + 1])
    if ok and tostring(data.userId) == tostring(userId) then
      redis.call('HDEL', seatsKey, idx)
      table.insert(cleared, tonumber(idx))
    end
  end

  redis.call('DEL', userSeatKey)

  if #cleared > 0 then
    return cjson.encode({success = true, seatIndex = cleared[1], clearedSeatIndices = cleared})
  end
  return cjson.encode({success = false, error = "NOT_SEATED"})
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

  -- Remove anyone currently on that seat (a DIFFERENT user) + clean their
  -- reverse index. (If it's the same user being assigned to their own seat the
  -- entry is just re-written below.)
  local displaced = redis.call('HGET', seatsKey, tostring(seatIndex))
  if displaced then
    local dok, ddata = pcall(cjson.decode, displaced)
    if dok and tostring(ddata.userId) ~= tostring(userId) then
      redis.call('DEL', roomPrefix .. ddata.userId)
    end
    redis.call('HDEL', seatsKey, tostring(seatIndex))
  end

  -- F-41: Single-occupancy heal — remove the assigned user from EVERY other
  -- seat via a bounded HGETALL scan (see TAKE_SEAT_SCRIPT for the rationale:
  -- reverse-index desync would otherwise let one user accumulate ghosts).
  local cleared = {}
  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local ok, data = pcall(cjson.decode, all[i + 1])
    if ok and tostring(data.userId) == tostring(userId) and idx ~= tostring(seatIndex) then
      redis.call('HDEL', seatsKey, idx)
      table.insert(cleared, tonumber(idx))
    end
  end

  -- Assign user to the seat
  local seatData = cjson.encode({userId = userId, muted = false})
  redis.call('HSET', seatsKey, tostring(seatIndex), seatData)

  -- SEAT-005: Maintain user→seat reverse index
  redis.call('SET', userSeatKey, tostring(seatIndex))

  -- M-3 FIX: Ensure TTL on seat keys as crash safety net
  redis.call('EXPIRE', seatsKey, ${SEAT_KEY_TTL_SECONDS})
  redis.call('EXPIRE', userSeatKey, ${SEAT_KEY_TTL_SECONDS})

  local resp = {success = true, seatIndex = seatIndex}
  if #cleared > 0 then resp.clearedSeatIndices = cleared end
  return cjson.encode(resp)
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
// realtime-22: seat retention across reconnect
// ─────────────────────────────────────────────────────────────────

// Stamp a `disconnectedAt` marker on EVERY seat the user holds instead of
// releasing it (the disconnect path's alternative to LEAVE_SEAT). The seat stays
// OCCUPIED — others still get SEAT_TAKEN — so observers see no flicker. A bounded
// HGETALL scan mirrors LEAVE_SEAT_SCRIPT so a reverse-index desync can't leave a
// ghost seat un-marked. Returns every reserved index (empty → user held no seat,
// so the caller falls back to today's plain-leave behaviour).
export const RESERVE_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local userId = ARGV[1]
  local now = tonumber(ARGV[2])

  local reserved = {}
  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local ok, data = pcall(cjson.decode, all[i + 1])
    if ok and tostring(data.userId) == tostring(userId) then
      data.disconnectedAt = now
      redis.call('HSET', seatsKey, idx, cjson.encode(data))
      table.insert(reserved, tonumber(idx))
    end
  end

  if #reserved > 0 then
    redis.call('EXPIRE', seatsKey, ${SEAT_KEY_TTL_SECONDS})
    return cjson.encode({success = true, reservedSeatIndices = reserved})
  end
  return cjson.encode({success = false, error = "NOT_SEATED"})
`;

// Re-claim a held seat on rejoin. Only succeeds if the user STILL occupies a seat
// that carries a live (non-expired) `disconnectedAt` marker — reconciliation is
// implicit in the occupancy check: if the slot was reassigned (owner assign, or
// swept-then-retaken) the userId no longer matches, so reclaim yields and the
// user rejoins as a listener (never steals an occupied slot → no double-occupancy).
// On success it clears the marker (reactivates), restores the reverse index, and
// returns the slot so the join can mark the user a speaker again.
export const RECLAIM_SEAT_SCRIPT = `
  local seatsKey = KEYS[1]
  local userSeatKey = KEYS[2]
  local userId = ARGV[1]
  local now = tonumber(ARGV[2])
  local graceMs = tonumber(ARGV[3])

  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local ok, data = pcall(cjson.decode, all[i + 1])
    if ok and tostring(data.userId) == tostring(userId) and data.disconnectedAt ~= nil then
      if (now - data.disconnectedAt) <= graceMs then
        data.disconnectedAt = nil
        redis.call('HSET', seatsKey, idx, cjson.encode(data))
        redis.call('SET', userSeatKey, idx)
        redis.call('EXPIRE', seatsKey, ${SEAT_KEY_TTL_SECONDS})
        redis.call('EXPIRE', userSeatKey, ${SEAT_KEY_TTL_SECONDS})
        return cjson.encode({
          reclaimed = true,
          seatIndex = tonumber(idx),
          isMuted = data.muted and true or false,
        })
      end
    end
  end
  return cjson.encode({ reclaimed = false })
`;

// Sweep seats whose reconnect grace has expired: HDEL the seat, drop the user's
// reverse index, and return {index,userId} pairs so the caller can broadcast one
// seat:cleared + room:userLeft per slot. Runs ONLY on the CAS origin (see the
// ownership heartbeat), so exactly one instance sweeps → no duplicate clears.
// Update-in-place on an existing key: a swept-empty seats hash that closeRoom
// later deletes can never be resurrected here (this only ever HDELs fields).
export const SWEEP_EXPIRED_SEATS_SCRIPT = `
  local seatsKey = KEYS[1]
  local userSeatPrefix = ARGV[1]
  local now = tonumber(ARGV[2])
  local graceMs = tonumber(ARGV[3])

  local cleared = {}
  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local ok, data = pcall(cjson.decode, all[i + 1])
    if ok and data.disconnectedAt ~= nil and (now - data.disconnectedAt) > graceMs then
      redis.call('HDEL', seatsKey, idx)
      redis.call('DEL', userSeatPrefix .. tostring(data.userId))
      table.insert(cleared, { tonumber(idx), tonumber(data.userId) })
    end
  end
  return cjson.encode(cleared)
`;

// ─────────────────────────────────────────────────────────────────
// room-seat-caps/02: Seat Eviction (shrink)
// ─────────────────────────────────────────────────────────────────

// Atomically clear every occupied seat whose index is >= the room's new
// (lowered) seatCount. Mirrors SWEEP_EXPIRED_SEATS_SCRIPT's shape: a bounded
// HGETALL scan, HDEL the seat, DEL the user's reverse index, and return
// {index,userId} pairs so the caller can close each displaced user's producer
// and broadcast/target exactly once per evicted seat.
//
// NOTE — this script itself is atomic, but it is invoked as a SEPARATE
// EVALSHA from the RoomState.seatCount save that precedes it (seatCount and
// the seats hash live under different Redis keys). A take-seat that read the
// stale (higher) seatCount just before the save can still land a HSET at an
// index >= the new count AFTER this scan runs, leaving a ghost this pass
// does not catch. See seat-shrink-eviction.ts for the full analysis.
export const SHRINK_EVICT_SCRIPT = `
  local seatsKey = KEYS[1]
  local userSeatPrefix = ARGV[1]
  local newSeatCount = tonumber(ARGV[2])

  local evicted = {}
  local all = redis.call('HGETALL', seatsKey)
  for i = 1, #all, 2 do
    local idx = all[i]
    local idxNum = tonumber(idx)
    if idxNum >= newSeatCount then
      local ok, data = pcall(cjson.decode, all[i + 1])
      if ok then
        redis.call('HDEL', seatsKey, idx)
        redis.call('DEL', userSeatPrefix .. tostring(data.userId))
        table.insert(evicted, { idxNum, tonumber(data.userId) })
      end
    end
  end
  return cjson.encode(evicted)
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
  // realtime-22: seat retention across reconnect
  redis.defineCommand("seatReserve", {
    numberOfKeys: 1,
    lua: RESERVE_SEAT_SCRIPT,
  });
  redis.defineCommand("seatReclaim", {
    numberOfKeys: 2,
    lua: RECLAIM_SEAT_SCRIPT,
  });
  redis.defineCommand("seatSweepExpired", {
    numberOfKeys: 1,
    lua: SWEEP_EXPIRED_SEATS_SCRIPT,
  });
  // room-seat-caps/02: Seat Eviction (shrink)
  redis.defineCommand("seatEvictShrink", {
    numberOfKeys: 1,
    lua: SHRINK_EVICT_SCRIPT,
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
  // realtime-22: seat retention across reconnect
  seatReserve(...args: string[]): Promise<string>;
  seatReclaim(...args: string[]): Promise<string>;
  seatSweepExpired(...args: string[]): Promise<string>;
  // room-seat-caps/02: Seat Eviction (shrink)
  seatEvictShrink(...args: string[]): Promise<string>;
}
