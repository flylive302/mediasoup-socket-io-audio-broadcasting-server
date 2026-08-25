/**
 * gift-authority-tick-fanout 09 — room-server gift catalog cache.
 *
 * Boot backoff (1s → 30s cap, never blocks start), TTL refresh (re-reads
 * giftCatalogTtlMs() every tick), event-triggered refresh (refreshNow), and
 * failure-keeps-last-good are all interval-driven — fake timers throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let mockTtlMs = 60_000;
vi.mock("@src/domains/gift/flags.js", () => ({
  giftCatalogTtlMs: () => mockTtlMs,
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftCatalogSize: { set: vi.fn() },
    giftCatalogRefreshAgeSeconds: { set: vi.fn() },
  },
}));

import { logger } from "@src/infrastructure/logger.js";
import {
  startGiftCatalog,
  stopGiftCatalog,
  refreshNow,
  hasCatalog,
  getGift,
  isLuckyEnabled,
  catalogSize,
  lastRefreshAgeMs,
  __resetGiftCatalogForTests,
} from "@src/domains/gift/catalogCache.js";

const mockLogger = logger as unknown as {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

function snapshot(overrides: { luckyEnabled?: boolean; gifts?: Array<Record<string, unknown>> } = {}) {
  return {
    lucky_enabled: overrides.luckyEnabled ?? true,
    gifts: overrides.gifts ?? [
      { id: 1, price: 10, is_active: true, is_lucky: false, min_level: 0, vip_only: false },
      { id: 2, price: 500, is_active: true, is_lucky: true, min_level: 5, vip_only: true },
    ],
  };
}

function fakeClient(impl: () => Promise<ReturnType<typeof snapshot>>) {
  return { getGiftCatalog: vi.fn(impl) };
}

describe("catalogCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockTtlMs = 60_000;
    __resetGiftCatalogForTests();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    stopGiftCatalog();
    vi.useRealTimers();
  });

  it("hasCatalog() is false until the first successful fetch", () => {
    expect(hasCatalog()).toBe(false);
  });

  it("boot fetch success populates the cache and hasCatalog() becomes true", async () => {
    const client = fakeClient(async () => snapshot());
    startGiftCatalog(client, mockLogger as never);

    await vi.advanceTimersByTimeAsync(0);

    expect(hasCatalog()).toBe(true);
    expect(catalogSize()).toBe(2);
    expect(getGift(1)).toMatchObject({ id: 1, price: 10, isActive: true });
    expect(getGift(2)).toMatchObject({ vipOnly: true, minLevel: 5, isLucky: true });
    expect(isLuckyEnabled()).toBe(true);
  });

  it("boot fetch failure retries with exponential backoff (1s → 2s → 4s ... capped at 30s) and never throws", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      if (calls < 4) throw new Error("boom");
      return snapshot();
    });
    startGiftCatalog(client, mockLogger as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(hasCatalog()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000); // 1st retry
    expect(calls).toBe(2);
    expect(hasCatalog()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000); // 2nd retry (backoff doubled)
    expect(calls).toBe(3);

    await vi.advanceTimersByTimeAsync(4_000); // 3rd retry succeeds
    expect(calls).toBe(4);
    expect(hasCatalog()).toBe(true);
  });

  it("boot backoff never exceeds the 30s cap between retries, however long it keeps failing", async () => {
    const client = fakeClient(async () => {
      throw new Error("always fails");
    });
    startGiftCatalog(client, mockLogger as never);

    // Run well past where uncapped exponential growth (1s, 2s, 4s ... ) would
    // reach minutes-long gaps. Sampling total calls over two long windows of
    // equal length and comparing them bounds the steady-state retry cadence
    // at (windowMs / 30_000) retries per window — i.e. never slower than 30s.
    await vi.advanceTimersByTimeAsync(120_000);
    const callsAtT120 = client.getGiftCatalog.mock.calls.length;

    await vi.advanceTimersByTimeAsync(120_000);
    const callsAtT240 = client.getGiftCatalog.mock.calls.length;

    const retriesInSecondWindow = callsAtT240 - callsAtT120;
    // Once backoff has settled at the 30s cap, a 120s window contains at
    // least 3 retries (120_000 / 30_000, minus one for scheduling slack).
    expect(retriesInSecondWindow).toBeGreaterThanOrEqual(3);
    // And it must never be faster than the cap would allow in steady state.
    expect(retriesInSecondWindow).toBeLessThanOrEqual(6);
  });

  it("refreshes on the TTL timer, re-reading giftCatalogTtlMs() each tick", async () => {
    mockTtlMs = 5_000;
    const client = fakeClient(async () => snapshot());
    startGiftCatalog(client, mockLogger as never);
    await vi.advanceTimersByTimeAsync(0); // boot succeeds
    const callsAfterBoot = client.getGiftCatalog.mock.calls.length;

    // Flip TTL BEFORE the next tick fires: the currently-scheduled tick
    // (armed at boot with the OLD 5s value) still fires on the old cadence,
    // but it re-reads giftCatalogTtlMs() when it reschedules ITSELF — so the
    // tick after that one runs on the NEW cadence.
    mockTtlMs = 1_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.getGiftCatalog.mock.calls.length).toBe(callsAfterBoot + 1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getGiftCatalog.mock.calls.length).toBe(callsAfterBoot + 2);
  });

  it("refreshNow() triggers an immediate refresh outside the TTL cadence", async () => {
    const client = fakeClient(async () => snapshot());
    startGiftCatalog(client, mockLogger as never);
    await vi.advanceTimersByTimeAsync(0);

    const callsAfterBoot = client.getGiftCatalog.mock.calls.length;
    refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getGiftCatalog.mock.calls.length).toBe(callsAfterBoot + 1);
  });

  it("a refresh failure after boot success keeps the last good catalog and logs a warning", async () => {
    let shouldFail = false;
    const client = fakeClient(async () => {
      if (shouldFail) throw new Error("refresh failed");
      return snapshot();
    });
    startGiftCatalog(client, mockLogger as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogSize()).toBe(2);

    shouldFail = true;
    refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(catalogSize()).toBe(2); // unchanged
    expect(hasCatalog()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("getGift() returns undefined for an unknown gift id", async () => {
    const client = fakeClient(async () => snapshot());
    startGiftCatalog(client, mockLogger as never);
    await vi.advanceTimersByTimeAsync(0);

    expect(getGift(9999)).toBeUndefined();
  });

  it("lastRefreshAgeMs() is Infinity before any successful fetch, and grows after a successful refresh", async () => {
    expect(lastRefreshAgeMs()).toBe(Number.POSITIVE_INFINITY);

    const client = fakeClient(async () => snapshot());
    startGiftCatalog(client, mockLogger as never);
    await vi.advanceTimersByTimeAsync(0);

    expect(lastRefreshAgeMs()).toBeLessThan(1_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastRefreshAgeMs()).toBeGreaterThanOrEqual(5_000);
  });

  it("isLuckyEnabled() reflects the latest snapshot's kill-switch state", async () => {
    let lucky = true;
    const client = fakeClient(async () => snapshot({ luckyEnabled: lucky }));
    startGiftCatalog(client, mockLogger as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(isLuckyEnabled()).toBe(true);

    lucky = false;
    refreshNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(isLuckyEnabled()).toBe(false);
  });
});
