import fs from "node:fs";
import { Redis } from "ioredis";
import { config } from "@src/config/index.js";
import { logger } from "./logger.js";

/**
 * Two logical stores (aws-platform-build/21):
 * - DURABLE (`getRedisClient`): non-evicting, snapshotted store — in-flight
 *   money (`gifts:pending`), room/seat/block state, CAS ownership, revocation,
 *   event dedup/ordering. Configured via REDIS_*.
 * - CACHE (`getCacheRedisClient`): evict-freely store — rate limits, presence,
 *   socket mappings, socket.io pub/sub. Configured via REDIS_CACHE_*.
 * When REDIS_CACHE_HOST is unset the cache client IS the durable client, so a
 * deployment without the second store behaves exactly as before (ship-inert).
 */

let redisInstance: Redis | null = null;
let cacheInstance: Redis | null = null;

interface RedisConnOptions {
  host: string;
  port: number;
  db: number;
  username?: string | undefined;
  password?: string | undefined;
  tls: boolean;
  tlsCaPath?: string | undefined;
}

function createClient(opts: RedisConnOptions, label: string): Redis {
  const client = new Redis({
    host: opts.host,
    port: opts.port,
    db: opts.db,
    ...(opts.username && { username: opts.username }),
    ...(opts.password && { password: opts.password }),
    ...(opts.tls && {
      tls: {
        rejectUnauthorized: true,
        ...(opts.tlsCaPath && {
          ca: fs.readFileSync(opts.tlsCaPath, "utf8"),
        }),
      },
    }),
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  client.on("error", (err) => {
    logger.error({ err, store: label }, "Redis connection error");
  });

  client.on("connect", () => {
    logger.info({ store: label }, "Redis connected");
  });

  return client;
}

/** Durable-store client (money queue, room/seat/block state, revocation). */
export function getRedisClient(): Redis {
  if (redisInstance) return redisInstance;

  redisInstance = createClient(
    {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      db: config.REDIS_DB,
      username: config.REDIS_USERNAME,
      password: config.REDIS_PASSWORD,
      tls: config.REDIS_TLS,
      tlsCaPath: config.REDIS_TLS_CA_PATH,
    },
    "durable",
  );

  return redisInstance;
}

/**
 * Cache-store client (rate limits, presence, socket mappings, socket.io
 * adapter). Falls back to the durable client when REDIS_CACHE_HOST is unset.
 */
export function getCacheRedisClient(): Redis {
  if (!config.REDIS_CACHE_HOST) return getRedisClient();
  if (cacheInstance) return cacheInstance;

  cacheInstance = createClient(
    {
      host: config.REDIS_CACHE_HOST,
      port: config.REDIS_CACHE_PORT ?? config.REDIS_PORT,
      db: config.REDIS_CACHE_DB ?? 0,
      username: config.REDIS_CACHE_USERNAME,
      password: config.REDIS_CACHE_PASSWORD,
      tls: config.REDIS_CACHE_TLS,
      tlsCaPath: config.REDIS_CACHE_TLS_CA_PATH,
    },
    "cache",
  );

  return cacheInstance;
}

/** Gracefully disconnect the Redis singletons (for shutdown / tests) */
export async function disconnectRedis(): Promise<void> {
  if (cacheInstance && cacheInstance !== redisInstance) {
    await cacheInstance.quit();
  }
  cacheInstance = null;
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
