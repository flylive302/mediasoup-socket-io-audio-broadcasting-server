/**
 * gift-authority-tick-fanout 03 — runtime flag source.
 *
 * Precedence: Redis hash field → env → default. Refreshed every
 * GIFT_FLAGS_REFRESH_MS from the durable Redis client; a Redis error or an
 * invalid hash value must never throw into the caller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  resolveGiftFlags,
  startGiftFlags,
  stopGiftFlags,
  getGiftFlags,
  giftBalanceAuthority,
  giftLegacyShape,
  giftRoomTickMs,
  giftPendingTtlMs,
  giftCatalogTtlMs,
  type GiftFlags,
} from "@src/domains/gift/flags.js";

const mockLogger = logger as unknown as {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const baseEnv: GiftFlags = {
  GIFT_BALANCE_AUTHORITY: "off",
  GIFT_LEGACY_SHAPE: true,
  GIFT_ROOM_TICK_MS: 0,
  GIFT_PENDING_TTL_MS: 30_000,
  GIFT_CATALOG_TTL_MS: 300_000,
};

function fakeRedis(hgetallImpl: () => Promise<Record<string, string>> | never) {
  return { hgetall: vi.fn(hgetallImpl) } as unknown as import("ioredis").Redis;
}

describe("resolveGiftFlags (pure)", () => {
  it("uses the env value when the hash has no field for a flag", () => {
    const result = resolveGiftFlags({}, baseEnv);
    expect(result).toEqual(baseEnv);
  });

  it("prefers a valid Redis hash field over env", () => {
    const result = resolveGiftFlags(
      { GIFT_BALANCE_AUTHORITY: "shadow", GIFT_ROOM_TICK_MS: "250" },
      baseEnv,
    );
    expect(result.GIFT_BALANCE_AUTHORITY).toBe("shadow");
    expect(result.GIFT_ROOM_TICK_MS).toBe(250);
    // Untouched fields keep the env value.
    expect(result.GIFT_LEGACY_SHAPE).toBe(true);
  });

  it("falls back to env when a Redis field fails its Zod shape, and reports it via onInvalid", () => {
    const onInvalid = vi.fn();
    const result = resolveGiftFlags(
      { GIFT_BALANCE_AUTHORITY: "bogus", GIFT_ROOM_TICK_MS: "-5" },
      baseEnv,
      onInvalid,
    );
    expect(result.GIFT_BALANCE_AUTHORITY).toBe("off");
    expect(result.GIFT_ROOM_TICK_MS).toBe(0);
    expect(onInvalid).toHaveBeenCalledWith("GIFT_BALANCE_AUTHORITY", "bogus");
    expect(onInvalid).toHaveBeenCalledWith("GIFT_ROOM_TICK_MS", "-5");
  });

  it("parses the boolean flag the same way env parses it (\"false\"/\"0\" only flip it off)", () => {
    expect(resolveGiftFlags({ GIFT_LEGACY_SHAPE: "false" }, baseEnv).GIFT_LEGACY_SHAPE).toBe(false);
    expect(resolveGiftFlags({ GIFT_LEGACY_SHAPE: "0" }, baseEnv).GIFT_LEGACY_SHAPE).toBe(false);
    expect(resolveGiftFlags({ GIFT_LEGACY_SHAPE: "anything-else" }, baseEnv).GIFT_LEGACY_SHAPE).toBe(true);
  });
});

describe("startGiftFlags / getGiftFlags (interval-driven)", () => {
  const originalConfig = { ...config };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(config, originalConfig, {
      GIFT_BALANCE_AUTHORITY: "off",
      GIFT_LEGACY_SHAPE: true,
      GIFT_ROOM_TICK_MS: 0,
      GIFT_PENDING_TTL_MS: 30_000,
      GIFT_CATALOG_TTL_MS: 300_000,
      GIFT_FLAGS_REFRESH_MS: 5_000,
      GIFT_FLAGS_REDIS_HASH: "gift:flags",
      INSTANCE_ID: "test-instance",
    });
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    stopGiftFlags();
    vi.useRealTimers();
  });

  it("initial value is env — before the first tick, getGiftFlags() matches config", () => {
    const redis = fakeRedis(async () => ({}));
    startGiftFlags(redis, mockLogger as never);
    expect(getGiftFlags()).toEqual({
      GIFT_BALANCE_AUTHORITY: "off",
      GIFT_LEGACY_SHAPE: true,
      GIFT_ROOM_TICK_MS: 0,
      GIFT_PENDING_TTL_MS: 30_000,
      GIFT_CATALOG_TTL_MS: 300_000,
    });
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  it("calls HGETALL once per refresh interval, and picks up a Redis override", async () => {
    const redis = fakeRedis(async () => ({ GIFT_BALANCE_AUTHORITY: "redis" }));
    startGiftFlags(redis, mockLogger as never);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(redis.hgetall).toHaveBeenCalledTimes(1);
    expect(giftBalanceAuthority()).toBe("redis");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(redis.hgetall).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(redis.hgetall).toHaveBeenCalledTimes(2);
  });

  it("logs exactly one 'Gift flag changed' line per changed field, none when unchanged", async () => {
    const redis = fakeRedis(async () => ({ GIFT_ROOM_TICK_MS: "500" }));
    startGiftFlags(redis, mockLogger as never);

    await vi.advanceTimersByTimeAsync(5_000);
    const changeLogs = mockLogger.info.mock.calls.filter((c) => c[1] === "Gift flag changed");
    expect(changeLogs).toHaveLength(1);
    expect(changeLogs[0][0]).toMatchObject({
      flag: "GIFT_ROOM_TICK_MS",
      from: 0,
      to: 500,
      instanceId: "test-instance",
    });

    mockLogger.info.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockLogger.info.mock.calls.filter((c) => c[1] === "Gift flag changed")).toHaveLength(0);
  });

  it("an invalid Redis value keeps the env value and warns without throwing", async () => {
    const redis = fakeRedis(async () => ({ GIFT_BALANCE_AUTHORITY: "not-a-mode" }));
    startGiftFlags(redis, mockLogger as never);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(giftBalanceAuthority()).toBe("off");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ flag: "GIFT_BALANCE_AUTHORITY", value: "not-a-mode" }),
      expect.stringContaining("invalid Redis value"),
    );
  });

  it("a Redis error keeps the last known value and never throws", async () => {
    const redis = fakeRedis(async () => ({ GIFT_ROOM_TICK_MS: "500" }));
    startGiftFlags(redis, mockLogger as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(giftRoomTickMs()).toBe(500);

    (redis.hgetall as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(vi.advanceTimersByTimeAsync(5_000)).resolves.not.toThrow();
    expect(giftRoomTickMs()).toBe(500);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("HGETALL failed"),
    );
  });

  it("exposes the other typed getters", async () => {
    const redis = fakeRedis(async () => ({
      GIFT_LEGACY_SHAPE: "false",
      GIFT_PENDING_TTL_MS: "45000",
      GIFT_CATALOG_TTL_MS: "600000",
    }));
    startGiftFlags(redis, mockLogger as never);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(giftLegacyShape()).toBe(false);
    expect(giftPendingTtlMs()).toBe(45_000);
    expect(giftCatalogTtlMs()).toBe(600_000);
  });
});
