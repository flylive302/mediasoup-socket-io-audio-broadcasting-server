import type { Redis } from "ioredis";
import type { RoomState } from "./types.js";

export class RoomStateRepository {
  private readonly PREFIX = "room:state:";
  private readonly TTL = 86400; // 24 hours

  constructor(private readonly redis: Redis) {}

  async save(state: RoomState): Promise<void> {
    const key = `${this.PREFIX}${state.id}`;
    await this.redis.setex(key, this.TTL, JSON.stringify(state));
  }

  async get(roomId: string): Promise<RoomState | null> {
    const key = `${this.PREFIX}${roomId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async delete(roomId: string): Promise<void> {
    const key = `${this.PREFIX}${roomId}`;
    await this.redis.del(key);
  }

  /** Atomic increment of participant count */
  async adjustParticipantCount(
    roomId: string,
    delta: number,
  ): Promise<number | null> {
    const key = `${this.PREFIX}${roomId}`;

    // Lua script for atomic increment
    // Updates participantCount and lastActivityAt, updates TTL
    const luaScript = `
      local data = redis.call('GET', KEYS[1])
      if not data then return nil end
      
      local state = cjson.decode(data)
      state.participantCount = math.max(0, state.participantCount + tonumber(ARGV[1]))
      state.lastActivityAt = tonumber(ARGV[2])
      
      local newState = cjson.encode(state)
      redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), newState)
      return state.participantCount
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      delta.toString(),
      Date.now().toString(),
      this.TTL.toString(),
    );

    return result as number | null;
  }
}
