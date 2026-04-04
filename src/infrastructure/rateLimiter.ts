import { Redis } from "ioredis";

export class RateLimiter {
  private readonly PREFIX = "ratelimit:";

  constructor(private readonly redis: Redis) {}

  /**
   * Check if action is allowed using sliding window or fixed window.
   * Using fixed window for simplicity and performance.
   * @param key Identifier (e.g. "chat:userId")
   * @param limit Max requests
   * @param windowSeconds Time window in seconds
   */
  async isAllowed(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const redisKey = `${this.PREFIX}${key}`;

    // INCR and EXPIRE
    const multi = this.redis.multi();
    multi.incr(redisKey);
    multi.expire(redisKey, windowSeconds, "NX"); // Set expiry only if not set

    const results = await multi.exec();
    if (!results || !results[0]) return false;

    // results[0] is [error, result]
    const count = results[0][1] as number;
    return count <= limit;
  }
}
