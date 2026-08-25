/**
 * gift-authority-tick-fanout 11 — balanceSync seam tests with a mocked
 * ledger. Money invariants themselves are proven against a real Redis in
 * tests/integration/gift/ledger.redis.test.ts (ticket 10); this file covers
 * the wiring: mode gate, warm/retry/refresh-throttle, never-throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let mockAuthority: "off" | "shadow" | "redis" = "shadow";
vi.mock("@src/domains/gift/flags.js", () => ({
  giftBalanceAuthority: () => mockAuthority,
  giftPendingTtlMs: () => 30_000,
}));

const { metricsMock, degradation, mockDebit, mockReconcile } = vi.hoisted(() => ({
  metricsMock: {
    giftWouldRejectTotal: { inc: vi.fn() },
    giftReconcileTotal: { inc: vi.fn() },
    giftPendingExpiredTotal: { inc: vi.fn() },
    giftBalanceWarmTotal: { inc: vi.fn() },
  },
  degradation: vi.fn(),
  mockDebit: vi.fn(),
  mockReconcile: vi.fn(),
}));
vi.mock("@src/infrastructure/metrics.js", () => ({ metrics: metricsMock }));
vi.mock("@src/shared/redis-degradation.js", () => ({
  recordRedisDegradation: (...a: unknown[]) => degradation(...a),
}));
vi.mock("@src/domains/gift/ledger.js", () => ({
  balKey: (id: number) => `bal:${id}`,
  pendKey: (id: number) => `pend:${id}`,
  GiftLedger: class {
    debit = (...a: unknown[]) => mockDebit(...a);
    reconcile = (...a: unknown[]) => mockReconcile(...a);
  },
}));

import {
  initBalanceSync,
  __resetBalanceSyncForTests,
  balanceAuthorityActive,
  toSnapshot,
  reconcileBalance,
  warmBalance,
  ensureWarm,
  forceRefresh,
  debitForTap,
  FORCE_REFRESH_MIN_INTERVAL_MS,
} from "@src/domains/gift/balanceSync.js";

const okReconcile = { db: 100, pend: 0, spendable: 100, seq: 1, expiredCount: 0 };

function wire() {
  const redis = { exists: vi.fn().mockResolvedValue(1) };
  const source = { getUserBalance: vi.fn().mockResolvedValue({ coins: "100", version: 3 }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initBalanceSync(redis as any, source, logger as any);
  return { redis, source, logger };
}

const tap = {
  userId: 7,
  txId: "tx-1",
  cost: 10,
  giftJson: '{"transaction_id":"tx-1"}',
  pendingListKey: "gifts:pending",
} as const;

describe("balanceSync (ticket 11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBalanceSyncForTests();
    mockAuthority = "shadow";
    mockReconcile.mockResolvedValue(okReconcile);
  });

  describe("mode gate", () => {
    it("off: nothing runs — no script, no read endpoint, debit is `skipped`", async () => {
      const { source } = wire();
      mockAuthority = "off";

      expect(balanceAuthorityActive()).toBe(false);
      expect(await reconcileBalance(7, { coins: "1", version: 1 }, ["tx"], "push")).toBeNull();
      expect(await warmBalance(7)).toBe(false);
      await ensureWarm(7);
      expect(await debitForTap(tap)).toEqual({ kind: "skipped" });

      expect(mockDebit).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(source.getUserBalance).not.toHaveBeenCalled();
    });

    it("not wired (init never called): same as off", async () => {
      expect(balanceAuthorityActive()).toBe(false);
      expect(await debitForTap(tap)).toEqual({ kind: "skipped" });
      expect(mockDebit).not.toHaveBeenCalled();
    });
  });

  describe("toSnapshot", () => {
    it("parses the wire shape (string coins, int version)", () => {
      expect(toSnapshot({ coins: "1234", version: 5 })).toEqual({ db: 1234, version: 5 });
      expect(toSnapshot({ coins: "1234.75", version: "5" })).toEqual({ db: 1234, version: 5 });
    });

    it("returns null without a version (older backend) or with junk coins", () => {
      expect(toSnapshot({ coins: "10" })).toBeNull();
      expect(toSnapshot({ coins: "abc", version: 1 })).toBeNull();
      expect(toSnapshot({ coins: "-1", version: 1 })).toBeNull();
      expect(toSnapshot(null)).toBeNull();
    });
  });

  describe("reconcileBalance", () => {
    it("passes snapshot, settled ids and the pending TTL to the script", async () => {
      wire();
      await reconcileBalance(7, { coins: "90", version: 4 }, ["a", "b"], "batch");
      expect(mockReconcile).toHaveBeenCalledWith(7, { db: 90, version: 4 }, ["a", "b"], 30_000);
      expect(metricsMock.giftReconcileTotal.inc).toHaveBeenCalledWith({ source: "batch" });
    });

    it("settles ids even when the payload carries no usable snapshot", async () => {
      wire();
      await reconcileBalance(7, { coins: "90" }, ["a"], "fallback");
      expect(mockReconcile).toHaveBeenCalledWith(7, null, ["a"], 30_000);
    });

    it("is a no-op with neither snapshot nor ids", async () => {
      wire();
      expect(await reconcileBalance(7, null, [], "push")).toBeNull();
      expect(mockReconcile).not.toHaveBeenCalled();
    });

    it("counts TTL-expired reservations and warns", async () => {
      const { logger } = wire();
      mockReconcile.mockResolvedValue({ ...okReconcile, expiredCount: 2 });
      await reconcileBalance(7, null, ["a"], "push");
      expect(metricsMock.giftPendingExpiredTotal.inc).toHaveBeenCalledWith(2);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("never throws: a Redis failure is logged, counted and returns null", async () => {
      const { logger } = wire();
      mockReconcile.mockRejectedValue(new Error("redis down"));
      expect(await reconcileBalance(7, null, ["a"], "push")).toBeNull();
      expect(degradation).toHaveBeenCalledWith("gift-ledger", "reconcile");
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("warmBalance / ensureWarm", () => {
    it("reads the endpoint and reconciles with the snapshot", async () => {
      const { source } = wire();
      expect(await warmBalance(7)).toBe(true);
      expect(source.getUserBalance).toHaveBeenCalledWith(7);
      expect(mockReconcile).toHaveBeenCalledWith(7, { db: 100, version: 3 }, [], 30_000);
      expect(metricsMock.giftBalanceWarmTotal.inc).toHaveBeenCalledWith({ outcome: "ok" });
    });

    it("404 → not_found, no reconcile", async () => {
      const { source } = wire();
      source.getUserBalance.mockResolvedValue(null);
      expect(await warmBalance(7)).toBe(false);
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(metricsMock.giftBalanceWarmTotal.inc).toHaveBeenCalledWith({ outcome: "not_found" });
    });

    it("endpoint error → false, counted, never throws", async () => {
      const { source } = wire();
      source.getUserBalance.mockRejectedValue(new Error("502"));
      expect(await warmBalance(7)).toBe(false);
      expect(metricsMock.giftBalanceWarmTotal.inc).toHaveBeenCalledWith({ outcome: "error" });
    });

    it("ensureWarm warms only when bal:{user} is absent", async () => {
      const { redis, source } = wire();
      redis.exists.mockResolvedValue(1);
      await ensureWarm(7);
      expect(source.getUserBalance).not.toHaveBeenCalled();

      redis.exists.mockResolvedValue(0);
      await ensureWarm(7);
      expect(source.getUserBalance).toHaveBeenCalledWith(7);
      expect(redis.exists).toHaveBeenCalledWith("bal:7");
    });

    it("ensureWarm swallows a Redis error", async () => {
      const { redis } = wire();
      redis.exists.mockRejectedValue(new Error("down"));
      await expect(ensureWarm(7)).resolves.toBeUndefined();
      expect(degradation).toHaveBeenCalledWith("gift-ledger", "ensure-warm");
    });
  });

  describe("forceRefresh throttle", () => {
    it("allows one refresh per user per second, independent per user", async () => {
      const { source } = wire();
      expect(await forceRefresh(7, 1_000)).toBe(true);
      expect(await forceRefresh(7, 1_000 + FORCE_REFRESH_MIN_INTERVAL_MS - 1)).toBe(false);
      expect(await forceRefresh(8, 1_000 + 10)).toBe(true);
      expect(await forceRefresh(7, 1_000 + FORCE_REFRESH_MIN_INTERVAL_MS)).toBe(true);
      expect(source.getUserBalance).toHaveBeenCalledTimes(3);
    });
  });

  describe("debitForTap", () => {
    it("ok: returns spendable/seq and calls the script with the tap's list key + JSON", async () => {
      wire();
      mockDebit.mockResolvedValue({ status: "ok", spendable: 90, seq: 2 });
      expect(await debitForTap(tap)).toEqual({ kind: "ok", spendable: 90, seq: 2 });
      expect(mockDebit).toHaveBeenCalledWith(7, "tx-1", 10, tap.giftJson, "gifts:pending");
    });

    it("cold: warms via the read endpoint and retries exactly once", async () => {
      const { source } = wire();
      mockDebit
        .mockResolvedValueOnce({ status: "cold" })
        .mockResolvedValueOnce({ status: "ok", spendable: 90, seq: 1 });
      expect(await debitForTap(tap)).toEqual({ kind: "ok", spendable: 90, seq: 1 });
      expect(source.getUserBalance).toHaveBeenCalledTimes(1);
      expect(mockDebit).toHaveBeenCalledTimes(2);
    });

    it("cold and the warm fails: would_reject cold, no second attempt", async () => {
      const { source } = wire();
      source.getUserBalance.mockResolvedValue(null);
      mockDebit.mockResolvedValue({ status: "cold" });
      expect(await debitForTap(tap)).toEqual({ kind: "would_reject", code: "cold", spendable: null });
      expect(mockDebit).toHaveBeenCalledTimes(1);
    });

    it("insufficient: forces one refresh, retries once, reports the final spendable", async () => {
      wire();
      mockDebit
        .mockResolvedValueOnce({ status: "insufficient", spendable: 5 })
        .mockResolvedValueOnce({ status: "insufficient", spendable: 5 });
      expect(await debitForTap(tap)).toEqual({ kind: "would_reject", code: "insufficient", spendable: 5 });
      expect(mockDebit).toHaveBeenCalledTimes(2);
    });

    it("insufficient while throttled: no refresh, no retry", async () => {
      const { source } = wire();
      mockDebit.mockResolvedValue({ status: "insufficient", spendable: 5 });
      await debitForTap(tap);
      vi.clearAllMocks();
      mockDebit.mockResolvedValue({ status: "insufficient", spendable: 5 });
      await debitForTap(tap); // within 1 s of the first forced refresh
      expect(source.getUserBalance).not.toHaveBeenCalled();
      expect(mockDebit).toHaveBeenCalledTimes(1);
    });

    it("no cost (catalog cold / unknown gift): no script run, reports the code", async () => {
      wire();
      expect(await debitForTap({ ...tap, cost: null, costCode: "no_catalog" })).toEqual({
        kind: "no_cost",
        code: "no_catalog",
      });
      expect(mockDebit).not.toHaveBeenCalled();
    });

    it("Redis unreachable: returns `error`, logs, never throws", async () => {
      const { logger } = wire();
      mockDebit.mockRejectedValue(new Error("ECONNRESET"));
      expect(await debitForTap(tap)).toEqual({ kind: "error" });
      expect(degradation).toHaveBeenCalledWith("gift-ledger", "debit");
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
