import type { Redis } from "ioredis";
import type { RoomMode, RoomState } from "./types.js";

export class RoomStateRepository {
  private readonly PREFIX = "room:state:";
  private readonly TTL = 86400; // 24 hours
  private commandDefined = false;

  constructor(private readonly redis: Redis) {}

  /**
   * Register the Lua script once via defineCommand for EVALSHA caching.
   * ROOM-PERF-001 FIX: Eliminates script recompilation on every call.
   */
  private ensureCommand(): void {
    if (this.commandDefined) return;
    this.redis.defineCommand("adjustParticipants", {
      numberOfKeys: 1,
      lua: `
        local data = redis.call('GET', KEYS[1])
        if not data then return nil end
        local state = cjson.decode(data)
        state.participantCount = math.max(0, state.participantCount + tonumber(ARGV[1]))
        state.lastActivityAt = tonumber(ARGV[2])
        local newState = cjson.encode(state)
        redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), newState)
        return state.participantCount
      `,
    });
    // realtime-01: reconcile participantCount to the authoritative socket-presence
    // count AND refresh the TTL. Update-if-exists only (returns nil if the key is
    // gone) so a heartbeat/leave reconcile that races closeRoom's delete() can
    // NEVER resurrect a zombie room:state key (see delete()'s B-3 note).
    this.redis.defineCommand("reconcileParticipants", {
      numberOfKeys: 1,
      lua: `
        local data = redis.call('GET', KEYS[1])
        if not data then return nil end
        local state = cjson.decode(data)
        state.participantCount = tonumber(ARGV[1])
        redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), cjson.encode(state))
        return state.participantCount
      `,
    });
    // realtime-08: set the Room's interactive↔broadcast mode. Update-if-exists
    // only (returns nil for a missing key) — same zombie-safety contract as
    // reconcileParticipants: a mode write racing closeRoom can never recreate a
    // closed Room's state key. Refreshes the 24h TTL so the write isn't a no-op
    // on liveness bookkeeping. Returns the stored mode, or nil if the key is gone.
    this.redis.defineCommand("setRoomMode", {
      numberOfKeys: 1,
      lua: `
        local data = redis.call('GET', KEYS[1])
        if not data then return nil end
        local state = cjson.decode(data)
        state.mode = ARGV[1]
        redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), cjson.encode(state))
        return state.mode
      `,
    });
    this.commandDefined = true;
  }

  async save(state: RoomState): Promise<void> {
    const key = `${this.PREFIX}${state.id}`;
    await this.redis.setex(key, this.TTL, JSON.stringify(state));
  }

  async get(roomId: string): Promise<RoomState | null> {
    const key = `${this.PREFIX}${roomId}`;
    const data = await this.redis.get(key);
    if (!data) {
      return null;
    }
    const state = JSON.parse(data) as RoomState;
    // realtime-08: legacy state keys written before `mode` existed default to
    // interactive so the controller has a defined starting point.
    state.mode ??= "interactive";
    return state;
  }

  /**
   * Delete room state from Redis.
   *
   * B-3 FIX: Must be called AFTER all adjustParticipantCount() calls are complete.
   * The Lua script in adjustParticipants safely returns nil when the key is absent,
   * so a concurrent adjust after delete is a no-op (not a zombie resurrection).
   * However, callers must NOT call adjustParticipantCount after delete to avoid
   * re-creating the key via SETEX in a theoretical race window.
   */
  async delete(roomId: string): Promise<void> {
    const key = `${this.PREFIX}${roomId}`;
    await this.redis.del(key);
  }

  /** Atomic increment of participant count (EVALSHA-cached) */
  async adjustParticipantCount(
    roomId: string,
    delta: number,
  ): Promise<number | null> {
    const key = `${this.PREFIX}${roomId}`;
    this.ensureCommand();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.redis as any).adjustParticipants(
      key,
      delta.toString(),
      Date.now().toString(),
      this.TTL.toString(),
    );

    return result as number | null;
  }

  /**
   * realtime-01: set participantCount to an authoritative absolute value (the
   * real socket-presence count) and refresh the 24h TTL — used by the presence
   * reconcile path. Returns the new count, or null if the room:state key no
   * longer exists (never re-creates it — see the Lua note in ensureCommand).
   */
  async reconcileParticipantCount(
    roomId: string,
    count: number,
  ): Promise<number | null> {
    const key = `${this.PREFIX}${roomId}`;
    this.ensureCommand();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.redis as any).reconcileParticipants(
      key,
      count.toString(),
      this.TTL.toString(),
    );

    return result as number | null;
  }

  /**
   * realtime-08: persist the Room's interactive↔broadcast mode. Update-if-exists
   * only — returns the stored mode, or null if the room:state key no longer
   * exists (never re-creates it).
   */
  async setMode(roomId: string, mode: RoomMode): Promise<RoomMode | null> {
    const key = `${this.PREFIX}${roomId}`;
    this.ensureCommand();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.redis as any).setRoomMode(
      key,
      mode,
      this.TTL.toString(),
    );

    return result as RoomMode | null;
  }
}
