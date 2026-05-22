import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";

/**
 * F-44: sliding-window rate limiter.
 *
 * The previous fixed-window (`INCR` + `EXPIRE NX`) allowed a 2× burst across a
 * window boundary (`limit` requests at t=59s and another `limit` at t=61s).
 * This implementation keeps a sorted set of request timestamps per key and
 * counts only those inside the trailing window, so the cap holds over ANY
 * `window`-length interval — not just the aligned bucket.
 *
 * The whole check is one atomic Lua script (single-threaded Redis execution),
 * so concurrent callers for the same key cannot both slip past the limit.
 */
const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]

  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
  local count = redis.call('ZCARD', key)
  if count < limit then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, windowMs)
    return 1
  end
  return 0
`;

interface RedisWithRateLimit {
  // Registered via defineCommand({ numberOfKeys: 1 }) — ioredis bakes the key
  // count in, so the command is invoked as (key, ...args) with NO leading
  // count. Passing a count shifts every ARGV by one (KEYS[1] becomes the
  // literal "1", ARGV[1] becomes the key) so `tonumber(ARGV[1])` is nil, the
  // Lua errors, and the catch fails closed → every gift/chat denied.
  rlSlidingWindow(
    key: string,
    now: string,
    windowMs: string,
    limit: string,
    member: string,
  ): Promise<number>;
}

export class RateLimiter {
  private readonly PREFIX = "ratelimit:";

  constructor(private readonly redis: Redis) {
    redis.defineCommand("rlSlidingWindow", {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });
  }

  /**
   * Check if an action is allowed under a sliding window.
   * @param key Identifier (e.g. "chat:userId")
   * @param limit Max requests within the window
   * @param windowSeconds Window length in seconds
   */
  async isAllowed(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const redisKey = `${this.PREFIX}${key}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    // Unique member so two requests in the same millisecond both count.
    const member = `${now}:${randomUUID()}`;

    try {
      const allowed = await (
        this.redis as unknown as RedisWithRateLimit
      ).rlSlidingWindow(
        redisKey,
        String(now),
        String(windowMs),
        String(limit),
        member,
      );
      return allowed === 1;
    } catch (err) {
      // F-44: explicit, configurable fail-policy. Default (RATE_LIMIT_FAIL_OPEN
      // = false) preserves the prior production behavior of denying on a Redis
      // error; flipping it to true aligns with jwtValidator's fail-open.
      logger.error(
        { err, key, failOpen: config.RATE_LIMIT_FAIL_OPEN },
        "RateLimiter Redis error — applying configured fail-policy",
      );
      return config.RATE_LIMIT_FAIL_OPEN;
    }
  }
}
