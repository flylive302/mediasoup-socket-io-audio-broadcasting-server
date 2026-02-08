import { Redis } from "ioredis";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (redisInstance) return redisInstance;

  redisInstance = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    db: config.REDIS_DB,
    ...(config.REDIS_USERNAME && { username: config.REDIS_USERNAME }),
    ...(config.REDIS_PASSWORD && { password: config.REDIS_PASSWORD }),
    ...(config.REDIS_TLS && { tls: { rejectUnauthorized: true } }),
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  redisInstance.on("error", (err) => {
    logger.error({ err }, "Redis connection error");
  });

  redisInstance.on("connect", () => {
    logger.info("Redis connected");
  });

  return redisInstance;
}
