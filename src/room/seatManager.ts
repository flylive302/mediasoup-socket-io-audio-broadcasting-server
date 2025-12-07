import type { Redis } from 'ioredis';
import type { Seat } from './types.js';

export class SeatManager {
  private readonly PREFIX = 'room:seats:';
  private readonly SEAT_COUNT = 9; // Grid of 9 speakers

  constructor(private readonly redis: Redis) {}

  async takeSeat(roomId: string, userId: string, position?: number): Promise<number | null> {
    const key = `${this.PREFIX}${roomId}`;
    const reqPos = position !== undefined ? position : -1;

    // Lua script to atomically find and take a seat
    const luaScript = `
      local key = KEYS[1]
      local userId = ARGV[1]
      local limit = tonumber(ARGV[2]) -- 9 seats
      local reqPos = tonumber(ARGV[3]) -- -1 if any seat

      -- Case 1: Specific seat requested
      if reqPos >= 0 then
        if redis.call('HEXISTS', key, reqPos) == 1 then
          return nil -- Taken
        end
        redis.call('HSET', key, reqPos, userId)
        return reqPos
      end

      -- Case 2: Any empty seat
      for i = 0, limit - 1 do
        if redis.call('HEXISTS', key, i) == 0 then
          redis.call('HSET', key, i, userId)
          return i
        end
      end
      
      return nil -- No seats available
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      userId,
      this.SEAT_COUNT.toString(),
      reqPos.toString()
    );

    return result as number | null;
  }

  async leaveSeat(roomId: string, userId: string): Promise<void> {
    const key = `${this.PREFIX}${roomId}`;
    const seats = await this.redis.hgetall(key);
    
    for (const [pos, occupant] of Object.entries(seats)) {
      if (occupant === userId) {
        await this.redis.hdel(key, pos);
        return;
      }
    }
  }

  async getSeats(roomId: string): Promise<Seat[]> {
    const key = `${this.PREFIX}${roomId}`;
    const data = await this.redis.hgetall(key);
    
    const seats: Seat[] = [];
    for (let i = 0; i < this.SEAT_COUNT; i++) {
        seats.push({
            index: i,
            userId: data[i.toString()] || null,
            muted: false // Mute state tracks separately if needed
        });
    }
    return seats;
  }
}
