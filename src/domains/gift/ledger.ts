/**
 * gift-authority-tick-fanout 10 — typed wrappers over the reserved-debit
 * ledger scripts (see ledger.lua-scripts.ts for the invariant proof).
 * EXECUTE-stage primitives; no handler or buffer uses them yet (ticket 11).
 */
import type { Redis } from "ioredis";
import {
  registerGiftLedgerCommands,
  type RedisWithGiftLedgerCommands,
} from "./ledger.lua-scripts.js";

export type DebitResult =
  | { status: "cold" }
  | { status: "insufficient"; spendable: number }
  | { status: "ok"; spendable: number; seq: number };

export interface ReconcileResult {
  db: number;
  pend: number;
  spendable: number;
  seq: number;
  expiredCount: number;
}

export interface BalanceSnapshot {
  /** Backend-confirmed absolute coin balance (integer). */
  db: number;
  /** Backend `balance_version` that produced `db`. */
  version: number;
}

export const balKey = (userId: number | string): string => `bal:${userId}`;
export const pendKey = (userId: number | string): string => `pend:${userId}`;

function assertInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer, got ${v}`);
  }
}

export class GiftLedger {
  private readonly redis: RedisWithGiftLedgerCommands;

  constructor(redis: Redis) {
    registerGiftLedgerCommands(redis);
    this.redis = redis as RedisWithGiftLedgerCommands;
  }

  /**
   * Reserve `cost` for `txId` and enqueue `giftJson` onto `pendingListKey` in
   * one atomic step. Idempotent per txId.
   */
  async debit(
    userId: number,
    txId: string,
    cost: number,
    giftJson: string,
    pendingListKey: string,
    now: number = Date.now(),
  ): Promise<DebitResult> {
    assertInt("cost", cost);
    const r = await this.redis.giftDebit(
      balKey(userId),
      pendKey(userId),
      pendingListKey,
      txId,
      String(cost),
      giftJson,
      String(now),
    );
    switch (r[0]) {
      case "cold":
        return { status: "cold" };
      case "insufficient":
        return { status: "insufficient", spendable: Number(r[1]) };
      case "ok":
        return { status: "ok", spendable: Number(r[1]), seq: Number(r[2]) };
      default:
        throw new Error(`giftDebit returned unexpected status ${String(r[0])}`);
    }
  }

  /**
   * Apply a (possibly absent) snapshot, release settled reservations, expire
   * old ones. Older snapshots (version ≤ stored) are ignored.
   */
  async reconcile(
    userId: number,
    snapshot: BalanceSnapshot | null,
    settledTxIds: string[],
    ttlMs: number,
    now: number = Date.now(),
  ): Promise<ReconcileResult> {
    if (snapshot) {
      assertInt("snapshot.db", snapshot.db);
      assertInt("snapshot.version", snapshot.version);
    }
    assertInt("ttlMs", ttlMs);
    const r = await this.redis.giftReconcile(
      balKey(userId),
      pendKey(userId),
      snapshot ? String(snapshot.db) : "",
      snapshot ? String(snapshot.version) : "",
      String(now),
      String(ttlMs),
      ...settledTxIds,
    );
    return {
      db: Number(r[0]),
      pend: Number(r[1]),
      spendable: Number(r[2]),
      seq: Number(r[3]),
      expiredCount: Number(r[4]),
    };
  }
}
