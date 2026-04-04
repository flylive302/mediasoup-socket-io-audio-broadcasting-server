import type { Redis } from "ioredis";
import type { RoomState } from "./types.js";

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
    this.commandDefined = true;
  }

  async save(state: RoomState): Promise<void> {
    const key = `${this.PREFIX}${state.id}`;
    await this.redis.setex(key, this.TTL, JSON.stringify(state));
  }

  async get(roomId: string): Promise<RoomState | null> {
    const key = `${this.PREFIX}${roomId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
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
}
