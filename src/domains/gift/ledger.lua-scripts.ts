/**
 * gift-authority-tick-fanout 10 — Reserved-debit ledger Lua scripts.
 *
 * Two atomic scripts make tap-time money decisions exact on the DURABLE Redis
 * (the one holding `gifts:pending`). Registered via `defineCommand` so callers
 * hit EVALSHA. Nothing in this file is wired into a handler yet (ticket 11).
 *
 * Keys (per user, all on the durable client):
 *   bal:{user}   hash  db   = last backend-confirmed balance (integer coins)
 *                      ver  = backend `balance_version` that produced `db`
 *                      pend = sum of reserved-but-unsettled debits
 *                      seq  = local monotonic counter, bumped by every script run
 *   pend:{user}  hash  txId → "<cost>|<reservedAtMs>"
 *
 * spendable = db − pend. Everything is integer arithmetic; the wrappers refuse
 * non-integer cost, and the scripts refuse a non-integer ARGV with an error
 * rather than rounding.
 *
 * ── Invariant proof (prose) ───────────────────────────────────────────────
 *
 * 1. No overspend. DEBIT reads db and pend, checks `db − pend ≥ cost`, and
 *    writes the reservation in the SAME script. Redis executes scripts
 *    serially per node, so two concurrent debits for one user are totally
 *    ordered: the second sees the first's `pend`. N concurrent debits can
 *    therefore never reserve more than `db` in total.
 *
 * 2. A debit cannot be lost. The reservation (`pend:{user}[txId]`, `pend +=
 *    cost`) and the enqueue (`RPUSH <pending list> giftJson`) happen in the
 *    same script — there is no moment where a gift is queued for booking
 *    without a reservation, or reserved without being queued. A crash between
 *    the two is impossible by construction; a crash before the script
 *    returns leaves nothing (atomic), and the tap is simply not accepted.
 *
 * 3. A rejection refunds by construction. An `insufficient` or `cold` result
 *    writes nothing — there is no reservation to undo, so no refund path can
 *    be forgotten. `ok` is the only branch that mutates.
 *
 * 4. Settlement is idempotent. RECONCILE releases a reservation only if the
 *    txId is still present in `pend:{user}` and deletes it in the same step;
 *    a second settlement of the same txId finds nothing and changes nothing.
 *
 * 5. Snapshots are monotonic. RECONCILE applies `snapDb` only when `snapVer`
 *    is strictly newer than the stored `ver`; an older snapshot arriving late
 *    (out-of-order push vs batch response) is ignored, so a confirmed balance
 *    can never regress to a stale one. A snapshot that already INCLUDES a
 *    settled debit is applied together with the settlement in one script, so
 *    there is no window where the debit is counted twice (once in `db`, once
 *    in `pend`).
 *
 * 6. Pending is bounded. RECONCILE expires reservations older than `ttl` and
 *    refunds them (`pend −= cost`), counting how many. A backend that never
 *    answers therefore cannot pin a user's spendable at zero forever; the
 *    booking side's own idempotency (transaction id) makes a late booking of an
 *    expired reservation harmless to the ledger — the next snapshot's `db`
 *    reflects it.
 *
 * 7. Idempotent DEBIT. A retried DEBIT with a txId already in `pend:{user}`
 *    returns `ok` with the current spendable and does NOT reserve or enqueue
 *    again, so a client retry after a lost ack cannot double-charge.
 */
import type { Redis } from "ioredis";

/**
 * DEBIT
 *   KEYS[1] = bal:{user}   KEYS[2] = pend:{user}   KEYS[3] = pending list
 *   ARGV[1] = txId  ARGV[2] = cost (int)  ARGV[3] = giftJson  ARGV[4] = now (ms)
 * Returns one of:
 *   {"cold"}                          no bal key for the user
 *   {"insufficient", spendable}       db − pend < cost
 *   {"ok", spendable, seq}            reserved + enqueued (or already reserved)
 */
export const GIFT_DEBIT_SCRIPT = `
  local txId = ARGV[1]
  local cost = tonumber(ARGV[2])
  local giftJson = ARGV[3]
  local now = tonumber(ARGV[4])
  if cost == nil or cost ~= math.floor(cost) or cost < 0 then
    return redis.error_reply('GIFT_DEBIT cost must be a non-negative integer')
  end
  if redis.call('EXISTS', KEYS[1]) == 0 then
    return {'cold'}
  end
  local db = tonumber(redis.call('HGET', KEYS[1], 'db')) or 0
  local pend = tonumber(redis.call('HGET', KEYS[1], 'pend')) or 0
  if redis.call('HEXISTS', KEYS[2], txId) == 1 then
    local seq = tonumber(redis.call('HGET', KEYS[1], 'seq')) or 0
    return {'ok', db - pend, seq}
  end
  if db - pend < cost then
    return {'insufficient', db - pend}
  end
  redis.call('HSET', KEYS[2], txId, tostring(cost) .. '|' .. tostring(now))
  pend = pend + cost
  redis.call('HSET', KEYS[1], 'pend', pend)
  local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
  redis.call('RPUSH', KEYS[3], giftJson)
  return {'ok', db - pend, seq}
`;

/**
 * RECONCILE
 *   KEYS[1] = bal:{user}   KEYS[2] = pend:{user}
 *   ARGV[1] = snapDb (int, or "" for none)  ARGV[2] = snapVer (int, or "" for none)
 *   ARGV[3] = now (ms)  ARGV[4] = ttl (ms)  ARGV[5..] = settled txIds
 * Returns {db, pend, spendable, seq, expiredCount}
 */
export const GIFT_RECONCILE_SCRIPT = `
  local snapDb = tonumber(ARGV[1])
  local snapVer = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  if snapDb ~= nil and snapDb ~= math.floor(snapDb) then
    return redis.error_reply('GIFT_RECONCILE snapDb must be an integer')
  end
  local ver = tonumber(redis.call('HGET', KEYS[1], 'ver')) or -1
  if snapDb ~= nil and snapVer ~= nil and snapVer > ver then
    redis.call('HSET', KEYS[1], 'db', snapDb, 'ver', snapVer)
  end
  local db = tonumber(redis.call('HGET', KEYS[1], 'db')) or 0
  local pend = tonumber(redis.call('HGET', KEYS[1], 'pend')) or 0

  for i = 5, #ARGV do
    local entry = redis.call('HGET', KEYS[2], ARGV[i])
    if entry then
      local cost = tonumber(string.match(entry, '^(%d+)|'))
      if cost then pend = pend - cost end
      redis.call('HDEL', KEYS[2], ARGV[i])
    end
  end

  local expired = 0
  local all = redis.call('HGETALL', KEYS[2])
  for i = 1, #all, 2 do
    local cost, ts = string.match(all[i + 1], '^(%d+)|(%d+)$')
    cost = tonumber(cost); ts = tonumber(ts)
    if ts == nil or (now - ts) > ttl then
      if cost then pend = pend - cost end
      redis.call('HDEL', KEYS[2], all[i])
      expired = expired + 1
    end
  end

  if pend < 0 then pend = 0 end
  redis.call('HSET', KEYS[1], 'pend', pend)
  local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
  return {db, pend, db - pend, seq, expired}
`;

export function registerGiftLedgerCommands(redis: Redis): void {
  redis.defineCommand("giftDebit", { numberOfKeys: 3, lua: GIFT_DEBIT_SCRIPT });
  redis.defineCommand("giftReconcile", { numberOfKeys: 2, lua: GIFT_RECONCILE_SCRIPT });
}

export interface RedisWithGiftLedgerCommands extends Redis {
  giftDebit(
    balKey: string,
    pendKey: string,
    listKey: string,
    txId: string,
    cost: string,
    giftJson: string,
    now: string,
  ): Promise<Array<string | number>>;
  giftReconcile(
    balKey: string,
    pendKey: string,
    snapDb: string,
    snapVer: string,
    now: string,
    ttl: string,
    ...settledTxIds: string[]
  ): Promise<Array<string | number>>;
}
