import { describe, it, expect, vi, afterEach } from "vitest";

// aws-platform-build/21: the cache client must be the SAME instance as the
// durable client when REDIS_CACHE_HOST is unset (ship-inert single-store
// behaviour), and a distinct connection when it is set.

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockConfig: Record<string, unknown> = {
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: 6379,
  REDIS_DB: 3,
  REDIS_TLS: false,
};

vi.mock("@src/config/index.js", () => ({
  get config() {
    return mockConfig;
  },
}));

// ioredis constructor stub — never opens a socket.
vi.mock("ioredis", () => ({
  Redis: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
    on() {
      return this;
    }
    quit() {
      return Promise.resolve("OK");
    }
  },
}));

afterEach(() => {
  vi.resetModules();
  delete mockConfig.REDIS_CACHE_HOST;
  delete mockConfig.REDIS_CACHE_DB;
});

describe("redis store split", () => {
  it("cache client IS the durable client when REDIS_CACHE_HOST is unset", async () => {
    const { getRedisClient, getCacheRedisClient } = await import(
      "@src/infrastructure/redis.js"
    );
    expect(getCacheRedisClient()).toBe(getRedisClient());
  });

  it("cache client is a distinct connection when REDIS_CACHE_HOST is set", async () => {
    mockConfig.REDIS_CACHE_HOST = "cache.example.internal";
    mockConfig.REDIS_CACHE_DB = 0;
    const { getRedisClient, getCacheRedisClient } = await import(
      "@src/infrastructure/redis.js"
    );
    const durable = getRedisClient();
    const cache = getCacheRedisClient();
    expect(cache).not.toBe(durable);
    expect(
      (cache as unknown as { opts: { host: string; db: number } }).opts.host,
    ).toBe("cache.example.internal");
    expect(
      (cache as unknown as { opts: { host: string; db: number } }).opts.db,
    ).toBe(0);
  });

  it("disconnectRedis quits both and resets the singletons", async () => {
    mockConfig.REDIS_CACHE_HOST = "cache.example.internal";
    const mod = await import("@src/infrastructure/redis.js");
    const durable = mod.getRedisClient();
    const cache = mod.getCacheRedisClient();
    await mod.disconnectRedis();
    expect(mod.getRedisClient()).not.toBe(durable);
    expect(mod.getCacheRedisClient()).not.toBe(cache);
  });
});
