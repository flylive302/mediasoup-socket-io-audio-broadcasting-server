/**
 * gift-authority-tick-fanout 11 — the one place the reserved-debit ledger
 * (ledger.ts, ticket 10) is wired into live traffic.
 *
 * Callers (all REACT unless noted):
 *   - giftBuffer      after every booking response → reconcile per sender
 *                     with the snapshot + version + settled ids
 *   - event-router    on `balance.updated` → reconcile with snapshot + version
 *   - join-room       warm a cold key via the read endpoint (fire-and-forget)
 *   - giftHandler     (EXECUTE, shadow) run the debit script and log whether
 *                     the tap WOULD be rejected — never changes the ack
 *
 * Mode gate (`GIFT_BALANCE_AUTHORITY`, read fresh on every call):
 *   off    → every function here is a no-op; scripts never run; behaviour is
 *            byte-identical to before this epic.
 *   shadow → ledger is kept exact and would-rejects are counted, no behaviour
 *            change. Redis unreachable ⇒ log + proceed as today.
 *   redis  → ticket 12 turns rejections real; until then identical to shadow.
 *
 * `metrics.ts` must never import this module (see the note there).
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { recordRedisDegradation } from "@src/shared/redis-degradation.js";
import { giftBalanceAuthority, giftPendingTtlMs, type GiftFlags } from "./flags.js";
import { GiftLedger, balKey, type DebitResult, type ReconcileResult } from "./ledger.js";

/** Wire shape shared by `balance.updated`, `processed[].balance` and the read endpoint. */
export interface BalanceWire {
  coins?: unknown;
  version?: unknown;
}

interface BalanceSource {
  getUserBalance(userId: number): Promise<BalanceWire | null>;
}

export type ReconcileSource = "batch" | "fallback" | "push" | "warm" | "refresh";

/** Insufficient-retry refreshes are throttled to one per user per second. */
export const FORCE_REFRESH_MIN_INTERVAL_MS = 1_000;
const REFRESH_STAMP_MAX = 10_000;

let ledger: GiftLedger | null = null;
let redisClient: Redis | null = null;
let source: BalanceSource | null = null;
let log: Logger | null = null;
const lastForcedRefreshAt = new Map<number, number>();

export function initBalanceSync(redis: Redis, balances: BalanceSource, logger: Logger): void {
  ledger = new GiftLedger(redis);
  redisClient = redis;
  source = balances;
  log = logger;
}

export function __resetBalanceSyncForTests(): void {
  ledger = null;
  redisClient = null;
  source = null;
  log = null;
  lastForcedRefreshAt.clear();
}

/** Current mode; `off` when not wired regardless of the flag. */
export function balanceAuthorityMode(): GiftFlags["GIFT_BALANCE_AUTHORITY"] {
  return ledger === null ? "off" : giftBalanceAuthority();
}

/** ticket 12: rejections are real only in `redis` mode. */
export function balanceAuthorityEnforcing(): boolean {
  return balanceAuthorityMode() === "redis";
}

/**
 * ticket 12: current spendable + seq for a refusal ack. Null when cold or
 * unreachable — the ack then omits the balance rather than guessing.
 */
export async function readSpendable(userId: number): Promise<{ spendable: number; seq: number } | null> {
  if (!balanceAuthorityActive() || !redisClient) return null;
  try {
    const [db, pend, seq] = await redisClient.hmget(balKey(userId), "db", "pend", "seq");
    if (db === null) return null;
    return { spendable: Number(db) - Number(pend ?? 0), seq: Number(seq ?? 0) };
  } catch (err) {
    recordRedisDegradation("gift-ledger", "read-spendable");
    log?.debug({ err, userId }, "gift ledger: readSpendable skipped");
    return null;
  }
}

/**
 * ticket 12: rewrite a backend balance payload so the client sees SPENDABLE
 * coins (db − pending) plus the ledger `seq`; diamonds/XP pass through.
 * Only meaningful in redis mode — callers pass the reconcile result.
 */
export function rewriteBalancePush<T extends Record<string, unknown>>(
  payload: T,
  ledgerState: { spendable: number; seq: number } | null,
): T & { seq?: number } {
  if (!ledgerState) return payload;
  return { ...payload, coins: String(ledgerState.spendable), seq: ledgerState.seq };
}

/** True when the ledger should be touched at all (mode ≠ off AND wired). */
export function balanceAuthorityActive(): boolean {
  return ledger !== null && giftBalanceAuthority() !== "off";
}

/**
 * Parse a wire snapshot into the ledger's integer form. Returns null when the
 * payload cannot be trusted as a snapshot (non-numeric coins, or no version —
 * an older backend); settlement of ids still proceeds without it.
 */
export function toSnapshot(wire: BalanceWire | null | undefined): { db: number; version: number } | null {
  if (!wire) return null;
  const coins = Number(wire.coins);
  const version = Number(wire.version);
  if (!Number.isFinite(coins) || coins < 0) return null;
  if (!Number.isSafeInteger(version) || version < 0) return null;
  return { db: Math.floor(coins), version };
}

/**
 * REACT: apply a snapshot and/or settle reservations for one user. Never
 * throws — a ledger failure is logged and counted, the caller proceeds.
 */
export async function reconcileBalance(
  userId: number,
  wire: BalanceWire | null | undefined,
  settledTxIds: readonly string[],
  from: ReconcileSource,
): Promise<ReconcileResult | null> {
  if (!balanceAuthorityActive() || !ledger) return null;
  const snapshot = toSnapshot(wire);
  if (snapshot === null && settledTxIds.length === 0) return null;
  try {
    const result = await ledger.reconcile(userId, snapshot, [...settledTxIds], giftPendingTtlMs());
    metrics.giftReconcileTotal.inc({ source: from });
    if (result.expiredCount > 0) {
      metrics.giftPendingExpiredTotal.inc(result.expiredCount);
      log?.warn(
        { userId, expired: result.expiredCount, source: from, pend: result.pend },
        "gift ledger: reservations expired by TTL (backend never settled them)",
      );
    }
    return result;
  } catch (err) {
    recordRedisDegradation("gift-ledger", "reconcile");
    log?.warn({ err, userId, source: from }, "gift ledger reconcile failed — skipped");
    return null;
  }
}

/**
 * Fetch the authoritative snapshot from the backend read endpoint and apply
 * it. Returns true when a snapshot was applied.
 */
export async function warmBalance(userId: number, from: "warm" | "refresh" = "warm"): Promise<boolean> {
  if (!balanceAuthorityActive() || !source) return false;
  let wire: BalanceWire | null;
  try {
    wire = await source.getUserBalance(userId);
  } catch (err) {
    metrics.giftBalanceWarmTotal.inc({ outcome: "error" });
    log?.warn({ err, userId, source: from }, "gift ledger: balance read failed");
    return false;
  }
  if (wire === null) {
    metrics.giftBalanceWarmTotal.inc({ outcome: "not_found" });
    return false;
  }
  const result = await reconcileBalance(userId, wire, [], from);
  metrics.giftBalanceWarmTotal.inc({ outcome: result ? "ok" : "error" });
  return result !== null;
}

/** REACT (join-room): warm only when the key is cold. Never throws. */
export async function ensureWarm(userId: number): Promise<void> {
  if (!balanceAuthorityActive() || !redisClient) return;
  try {
    const exists = await redisClient.exists(balKey(userId));
    if (exists === 0) await warmBalance(userId, "warm");
  } catch (err) {
    recordRedisDegradation("gift-ledger", "ensure-warm");
    log?.debug({ err, userId }, "gift ledger: ensureWarm skipped");
  }
}

/**
 * Forced refresh after an `insufficient` verdict — at most once per user per
 * second, so a user hammering the button at zero balance cannot turn the
 * ledger into a read-endpoint amplifier. Returns false when throttled.
 */
export async function forceRefresh(userId: number, now: number = Date.now()): Promise<boolean> {
  const last = lastForcedRefreshAt.get(userId);
  if (last !== undefined && now - last < FORCE_REFRESH_MIN_INTERVAL_MS) return false;
  if (lastForcedRefreshAt.size >= REFRESH_STAMP_MAX) {
    for (const [id, at] of lastForcedRefreshAt) {
      if (now - at >= FORCE_REFRESH_MIN_INTERVAL_MS) lastForcedRefreshAt.delete(id);
    }
  }
  lastForcedRefreshAt.set(userId, now);
  return warmBalance(userId, "refresh");
}

export type DebitVerdict =
  | { kind: "skipped" } // mode off / not wired
  | { kind: "error" } // Redis unreachable — caller proceeds as today
  | { kind: "no_cost"; code: "no_catalog" | "unknown_gift" }
  | { kind: "would_reject"; code: "cold" | "insufficient"; spendable: number | null }
  | { kind: "ok"; spendable: number; seq: number };

/**
 * EXECUTE: run the reserved-debit script for one tap. `cold` → warm + retry
 * once; `insufficient` → forced refresh (throttled) + retry once. On `ok` the
 * script has ALSO enqueued `giftJson` onto `pendingListKey` (same list, same
 * JSON the buffer would push) — the caller must not enqueue it again.
 */
export async function debitForTap(args: {
  userId: number;
  txId: string;
  cost: number | null;
  costCode?: "no_catalog" | "unknown_gift";
  giftJson: string;
  pendingListKey: string;
}): Promise<DebitVerdict> {
  if (!balanceAuthorityActive() || !ledger) return { kind: "skipped" };
  if (args.cost === null) return { kind: "no_cost", code: args.costCode ?? "unknown_gift" };
  const attempt = (): Promise<DebitResult> =>
    ledger!.debit(args.userId, args.txId, args.cost as number, args.giftJson, args.pendingListKey);
  try {
    let r = await attempt();
    if (r.status === "cold") {
      if (await warmBalance(args.userId, "warm")) r = await attempt();
    } else if (r.status === "insufficient") {
      if (await forceRefresh(args.userId)) r = await attempt();
    }
    switch (r.status) {
      case "ok":
        return { kind: "ok", spendable: r.spendable, seq: r.seq };
      case "cold":
        return { kind: "would_reject", code: "cold", spendable: null };
      case "insufficient":
        return { kind: "would_reject", code: "insufficient", spendable: r.spendable };
    }
  } catch (err) {
    recordRedisDegradation("gift-ledger", "debit");
    log?.warn({ err, userId: args.userId, txId: args.txId }, "gift ledger debit failed — proceeding without it");
    return { kind: "error" };
  }
}
