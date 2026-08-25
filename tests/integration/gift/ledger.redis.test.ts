/**
 * gift-authority-tick-fanout 10 — reserved-debit ledger against a REAL Redis.
 *
 * Address: MSAB_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379/15), else
 * REDIS_HOST/REDIS_PORT with db 15. Skipped LOUDLY when no Redis answers —
 * these invariants are only meaningful at the real seam (scripts are atomic
 * per node; mocks can't prove that). CI must provide one.
 *
 * Every test uses a unique key namespace and cleans up after itself; the test
 * db is never flushed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Redis } from "ioredis";
import { GiftLedger, balKey, pendKey } from "@src/domains/gift/ledger.js";

const url =
  process.env.MSAB_TEST_REDIS_URL ??
  `redis://${process.env.REDIS_HOST ?? "127.0.0.1"}:${process.env.REDIS_PORT ?? "6379"}/15`;

let redis: Redis | null = null;
let available = false;

beforeAll(async () => {
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 });
  try {
    await probe.connect();
    await probe.ping();
    redis = probe;
    available = true;
  } catch {
    probe.disconnect();
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠️  ledger.redis.test.ts SKIPPED — no Redis at ${url}. ` +
        `Set MSAB_TEST_REDIS_URL to run the money-invariant suite.\n`,
    );
  }
});

afterAll(async () => {
  await redis?.quit();
});

const TTL = 30_000;
let userCounter = 0;
const usedUsers: number[] = [];
const usedLists: string[] = [];

function freshUser(): number {
  const id = 9_000_000 + Date.now() % 1_000_000 * 100 + ++userCounter;
  usedUsers.push(id);
  return id;
}
function listFor(user: number): string {
  const k = `test:ledger:pending:${user}`;
  usedLists.push(k);
  return k;
}

afterEach(async () => {
  if (!redis) return;
  const keys = [...usedUsers.flatMap((u) => [balKey(u), pendKey(u)]), ...usedLists];
  if (keys.length) await redis.del(...keys);
  usedUsers.length = 0;
  usedLists.length = 0;
});

describe("GiftLedger (real Redis)", () => {
  const skipUnlessRedis = () => {
    if (!available) return true;
    return false;
  };

  it("cold: no bal key → {cold}, nothing written", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    const r = await ledger.debit(u, "tx1", 100, "{}", listFor(u));
    expect(r).toEqual({ status: "cold" });
    expect(await redis!.exists(pendKey(u))).toBe(0);
    expect(await redis!.llen(listFor(u))).toBe(0);
  });

  it("snapshot warms the key; debit reserves + enqueues in one step; insufficient writes nothing", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    const list = listFor(u);
    const warm = await ledger.reconcile(u, { db: 1000, version: 1 }, [], TTL);
    expect(warm).toMatchObject({ db: 1000, pend: 0, spendable: 1000, expiredCount: 0 });

    const ok = await ledger.debit(u, "tx1", 600, '{"t":"tx1"}', list);
    expect(ok).toMatchObject({ status: "ok", spendable: 400 });
    expect(await redis!.lrange(list, 0, -1)).toEqual(['{"t":"tx1"}']);
    expect(await redis!.hget(pendKey(u), "tx1")).toMatch(/^600\|\d+$/);

    const no = await ledger.debit(u, "tx2", 401, '{"t":"tx2"}', list);
    expect(no).toEqual({ status: "insufficient", spendable: 400 });
    expect(await redis!.llen(list)).toBe(1);
    expect(await redis!.hlen(pendKey(u))).toBe(1);
  });

  it("debit is idempotent per txId (retry after lost ack never double-reserves)", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    const list = listFor(u);
    await ledger.reconcile(u, { db: 1000, version: 1 }, [], TTL);
    await ledger.debit(u, "tx1", 300, "{}", list);
    const again = await ledger.debit(u, "tx1", 300, "{}", list);
    expect(again).toMatchObject({ status: "ok", spendable: 700 });
    expect(await redis!.llen(list)).toBe(1);
  });

  it("older snapshot is ignored; newer snapshot without settlement keeps the debit pending", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    await ledger.reconcile(u, { db: 1000, version: 5 }, [], TTL);
    await ledger.debit(u, "tx1", 300, "{}", listFor(u));

    const stale = await ledger.reconcile(u, { db: 5000, version: 4 }, [], TTL);
    expect(stale).toMatchObject({ db: 1000, pend: 300, spendable: 700 });

    const newer = await ledger.reconcile(u, { db: 900, version: 6 }, [], TTL);
    expect(newer).toMatchObject({ db: 900, pend: 300, spendable: 600 });
  });

  it("settlement together with the including snapshot yields exactly db − 0; duplicate settlement is a no-op", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    await ledger.reconcile(u, { db: 1000, version: 1 }, [], TTL);
    await ledger.debit(u, "tx1", 300, "{}", listFor(u));

    const settled = await ledger.reconcile(u, { db: 700, version: 2 }, ["tx1"], TTL);
    expect(settled).toMatchObject({ db: 700, pend: 0, spendable: 700 });

    const dup = await ledger.reconcile(u, null, ["tx1"], TTL);
    expect(dup).toMatchObject({ db: 700, pend: 0, spendable: 700 });
    expect(dup.seq).toBe(settled.seq + 1);
  });

  it("expiry refunds reservations older than ttl and counts them", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    const t0 = 1_000_000;
    await ledger.reconcile(u, { db: 1000, version: 1 }, [], TTL, t0);
    await ledger.debit(u, "old", 100, "{}", listFor(u), t0);
    await ledger.debit(u, "young", 200, "{}", listFor(u), t0 + TTL);

    const r = await ledger.reconcile(u, null, [], TTL, t0 + TTL + 1);
    expect(r).toMatchObject({ pend: 200, spendable: 800, expiredCount: 1 });
    expect(await redis!.hexists(pendKey(u), "old")).toBe(0);
    expect(await redis!.hexists(pendKey(u), "young")).toBe(1);
  });

  it("50 concurrent debits on one user never exceed the balance", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    const list = listFor(u);
    await ledger.reconcile(u, { db: 1000, version: 1 }, [], TTL);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => ledger.debit(u, `tx${i}`, 70, `{"i":${i}}`, list)),
    );
    const oks = results.filter((r) => r.status === "ok").length;
    expect(oks).toBe(14); // floor(1000 / 70)
    expect(results.filter((r) => r.status === "insufficient").length).toBe(36);
    expect(Number(await redis!.hget(balKey(u), "pend"))).toBe(980);
    expect(await redis!.llen(list)).toBe(14);
    const final = await ledger.reconcile(u, null, [], TTL);
    expect(final.spendable).toBe(20);
    expect(final.spendable).toBeGreaterThanOrEqual(0);
  });

  it("integer-only arithmetic: fractional cost is refused before Redis, fractional snapshot by the script", async ({ skip }) => {
    if (skipUnlessRedis()) return skip();
    const ledger = new GiftLedger(redis!);
    const u = freshUser();
    await expect(ledger.debit(u, "tx", 1.5, "{}", listFor(u))).rejects.toThrow(TypeError);
    await expect(ledger.reconcile(u, { db: 10.5, version: 1 }, [], TTL)).rejects.toThrow(TypeError);
    await redis!.hset(balKey(u), "db", "1000", "ver", "1", "pend", "0", "seq", "0");
    const raw = redis! as unknown as { giftReconcile: (...a: string[]) => Promise<unknown> };
    await expect(raw.giftReconcile(balKey(u), pendKey(u), "10.5", "2", "0", "1000")).rejects.toThrow(/integer/);
  });
});
