import type { Server as SocketServer } from "socket.io";
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type {
  BatchProcessingResult,
  GiftTransaction,
} from "@src/integrations/types.js";
import { config } from "@src/config/index.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { recordRedisDegradation } from "@src/shared/redis-degradation.js";
import { giftFlushPartitions, giftPendingTtlMs } from "./flags.js";

/**
 * Max transactions per flush — prevents large accumulated batches from
 * causing HTTP timeouts. Remaining items stay in the queue for the next tick.
 */
const MAX_BATCH_SIZE = 50;

/**
 * Lua script: atomically pop up to N items from the left of a list.
 * Returns the popped items as an array, or an empty array if the list is empty.
 * This is more efficient than LPOP in a loop (single round-trip).
 * Used by the dead-letter consumer (KEYS[1] = gifts:dead_letter).
 */
const ATOMIC_LPOP_N_LUA = `
  local items = redis.call('lrange', KEYS[1], 0, ARGV[1] - 1)
  if #items > 0 then
    redis.call('ltrim', KEYS[1], #items, -1)
  end
  return items
`;

/**
 * gift-authority-tick-fanout 04: CLAIM instead of pop. Atomically moves up to
 * N items from the head of the pending list (KEYS[1]) to the tail of this
 * instance's in-flight list (KEYS[2]) and returns them. A gift is never held
 * only in process memory: until the backend confirms it, it lives in
 * `gifts:inflight:{instanceId}`, which `reclaimInflight()` moves back to
 * pending on the next boot of this instance.
 */
const ATOMIC_CLAIM_N_LUA = `
  local items = redis.call('lrange', KEYS[1], 0, ARGV[1] - 1)
  if #items > 0 then
    redis.call('ltrim', KEYS[1], #items, -1)
    redis.call('rpush', KEYS[2], unpack(items))
  end
  return items
`;

/**
 * gift-authority-tick-fanout 04: move EVERY item of KEYS[1] (in-flight) back
 * to KEYS[2] (pending), preserving order, and return the count. Boot reclaim
 * and shutdown return path. Chunked so a huge list can't exceed Lua's unpack
 * limit.
 */
const ATOMIC_MOVE_ALL_LUA = `
  local moved = 0
  while true do
    local items = redis.call('lrange', KEYS[1], 0, 999)
    if #items == 0 then break end
    redis.call('rpush', KEYS[2], unpack(items))
    redis.call('ltrim', KEYS[1], #items, -1)
    moved = moved + #items
  end
  return moved
`;

interface BufferedGift extends GiftTransaction {
  retryCount?: number;
}

// GF-006 FIX: Cap dead-letter queue to prevent unbounded Redis memory growth.
// gift-authority-tick-fanout 04: raised 10 000 → 50 000. Trimming DESTROYS
// gifts the room already rendered, so it is now a last resort that only fires
// above the cap (and is logged); the 80 % high-water mark alerts first.
export const DEAD_LETTER_MAX_LENGTH = 50_000;
export const DEAD_LETTER_HIGH_WATER = Math.floor(DEAD_LETTER_MAX_LENGTH * 0.8);
/** How often the dead-letter consumer runs (ticket 04). */
export const DEAD_LETTER_CONSUMER_INTERVAL_MS = 30_000;
/** Max parked gifts replayed per consumer tick — same bound as a flush. */
const DEAD_LETTER_REPLAY_BATCH = MAX_BATCH_SIZE;

/** Hard cap on partitions — matches the Zod max so boot reclaim can enumerate. */
export const MAX_FLUSH_PARTITIONS = 16;

/**
 * ticket 05: per-partition flush state. Partition 0 keeps today's key names
 * (`gifts:pending`, `gifts:inflight:{instance}`) so partitions=1 is
 * byte-identical to the pre-partition buffer; p ≥ 1 gets a `:{p}` suffix.
 */
interface Partition {
  readonly index: number;
  readonly queueKey: string;
  readonly inflightKey: string;
  isFlushing: boolean;
  flushCount: number;
}

export class GiftBuffer {
  private readonly QUEUE_KEY = "gifts:pending";
  private readonly DEAD_LETTER_KEY = "gifts:dead_letter";
  /** Per-instance claim list — see ATOMIC_CLAIM_N_LUA (ticket 04). */
  private readonly INFLIGHT_KEY = `gifts:inflight:${config.INSTANCE_ID}`;
  private timer: NodeJS.Timeout | null = null;
  private deadLetterTimer: NodeJS.Timeout | null = null;
  /** ticket 05: partitions currently flushed; grows/shrinks with the flag. */
  private activePartitions = 1;
  private isReplaying = false;
  /**
   * ticket 04: the dead-letter consumer only replays while the backend is
   * known healthy — set by the most recent booking call's outcome. Starts
   * false so a boot into a dead backend never floods pending from the DLQ.
   */
  private lastBookingOk = false;

  constructor(
    private readonly redis: Redis,
    private readonly laravelClient: LaravelClient,
    private readonly io: SocketServer,
    private readonly logger: Logger,
  ) {}

  /**
   * Start the batch processor. ticket 04: this instance's in-flight list from
   * a previous life is moved back to pending BEFORE the first flush tick, so
   * a crash mid-booking never loses a gift (re-booking is idempotent by
   * transaction id on the Laravel side). Sync-callable: the reclaim is
   * awaited internally; `started` resolves once the timers are armed.
   */
  start(): void {
    if (this.timer || this.starting) return;
    this.starting = this.reclaimInflight()
      .catch((err) => {
        recordRedisDegradation("gift-buffer", "inflight-reclaim");
        this.logger.error(
          { err, key: this.INFLIGHT_KEY },
          "Gift buffer: in-flight reclaim failed at boot — items stay in the in-flight list for the next boot",
        );
      })
      .then(() => {
        if (this.timer) return;
        this.timer = setInterval(
          () => this.flushAll(),
          config.GIFT_BUFFER_FLUSH_INTERVAL_MS,
        );
        this.deadLetterTimer = setInterval(
          () => this.replayDeadLetters(),
          DEAD_LETTER_CONSUMER_INTERVAL_MS,
        );
        this.deadLetterTimer.unref?.();
        this.logger.info(
          {
            intervalMs: config.GIFT_BUFFER_FLUSH_INTERVAL_MS,
            deadLetterIntervalMs: DEAD_LETTER_CONSUMER_INTERVAL_MS,
          },
          "Gift buffer started",
        );
      });
  }

  private starting: Promise<void> | null = null;

  /** Resolves once start()'s boot reclaim finished and the timers are armed. */
  get started(): Promise<void> {
    return this.starting ?? Promise.resolve();
  }

  /**
   * ticket 04: move this instance's leftover in-flight gifts back to pending.
   * Returns the count (logged either way so a rollout can prove the path ran).
   */
  async reclaimInflight(): Promise<number> {
    // ticket 05: every partition this instance could have used in a previous
    // life (the flag may have been higher then) — cheap: one EVAL per key.
    let moved = 0;
    for (let p = 0; p < MAX_FLUSH_PARTITIONS; p++) {
      moved += (await this.redis.eval(
        ATOMIC_MOVE_ALL_LUA,
        2,
        this.inflightKey(p),
        this.queueKey(p),
      )) as number;
    }
    if (moved > 0) {
      metrics.giftInflightReclaimed.inc(moved);
    }
    this.logger.info(
      { reclaimed: moved, key: this.INFLIGHT_KEY },
      "Gift buffer: in-flight gifts reclaimed to pending at boot",
    );
    return moved;
  }

  /** Stop the batch processor and flush pending */
  async stop(): Promise<void> {
    await this.started;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.deadLetterTimer) {
      clearInterval(this.deadLetterTimer);
      this.deadLetterTimer = null;
    }
    this.logger.info("Gift buffer stopping, flushing pending items...");

    // F-39: a flush triggered by the last interval tick may still be in flight.
    // `flush()` early-returns while `isFlushing` is true, so a naive
    // `await this.flush()` here would be a no-op and shutdown would race the
    // in-flight Laravel HTTP / Redis re-queue against `redis.quit()`, dropping
    // popped-but-undelivered gifts. Wait (bounded) for the in-flight flush to
    // finish, THEN do one final flush to drain anything still queued.
    await this.waitForIdle();
    await this.flushAll();

    // ticket 04: anything still claimed (a flush that hit the idle deadline,
    // or a Redis error after the claim) goes back to pending so the NEXT
    // instance books it, instead of waiting for this instance's next boot.
    try {
      let returned = 0;
      for (let p = 0; p < this.activePartitions; p++) {
        returned += (await this.redis.eval(
          ATOMIC_MOVE_ALL_LUA,
          2,
          this.inflightKey(p),
          this.queueKey(p),
        )) as number;
      }
      if (returned > 0) {
        this.logger.warn(
          { returned, key: this.INFLIGHT_KEY },
          "Gift buffer: in-flight gifts returned to pending at shutdown",
        );
      }
    } catch (err) {
      recordRedisDegradation("gift-buffer", "inflight-return");
      this.logger.error(
        { err, key: this.INFLIGHT_KEY },
        "Gift buffer: could not return in-flight gifts at shutdown — they will be reclaimed at this instance's next boot",
      );
    }
    this.logger.info("Gift buffer stopped");
  }

  /**
   * F-39: poll until no flush is in flight, capped so shutdown can never hang.
   * The cap is generous relative to a single batch's Laravel round-trip.
   */
  private async waitForIdle(maxWaitMs = 10_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    const anyFlushing = () => this.partitions.some((p) => p.isFlushing);
    while (anyFlushing() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (anyFlushing()) {
      this.logger.warn(
        { maxWaitMs },
        "Gift buffer still flushing at shutdown deadline — proceeding with final flush attempt",
      );
    }
  }

  /**
   * Gifts still queued in Redis (crash-shutdown accounting). Unlike the
   * coalescer's in-memory map these are NOT lost on exit — they persist in
   * Redis for the next instance's flush loop — so the crash log reports them
   * as "left in queue", not "dropped". Returns -1 when Redis is unreachable.
   */
  async pendingCount(): Promise<number> {
    try {
      let total = 0;
      for (let p = 0; p < this.activePartitions; p++) {
        total += await this.redis.llen(this.queueKey(p));
      }
      return total;
    } catch (err) {
      recordRedisDegradation("gift-buffer", "pending-count");
      this.logger.warn({ err }, "Failed to get gift buffer pending count");
      return -1;
    }
  }

  /**
   * Add gift to buffer (called on each gift event). ticket 05: routed to the
   * sender's partition so every burst of one sender lands in one worker.
   */
  async enqueue(gift: GiftTransaction): Promise<void> {
    await this.redis.rpush(this.queueKeyFor(gift.sender_id), JSON.stringify(gift));
  }

  // ── ticket 05: partition plumbing ─────────────────────────────────────

  /** `gifts:pending` for partition 0, `gifts:pending:{p}` otherwise. */
  private queueKey(p: number): string {
    return p === 0 ? this.QUEUE_KEY : `${this.QUEUE_KEY}:${p}`;
  }

  private inflightKey(p: number): string {
    return p === 0 ? this.INFLIGHT_KEY : `${this.INFLIGHT_KEY}:${p}`;
  }

  /** Partition for a sender: `sender_id mod partitions` (flag read per call). */
  queueKeyFor(senderId: number): string {
    const n = giftFlushPartitions();
    return this.queueKey(n <= 1 ? 0 : Math.abs(senderId) % n);
  }

  private readonly partitions: Partition[] = Array.from(
    { length: MAX_FLUSH_PARTITIONS },
    (_, index) => ({ index, queueKey: "", inflightKey: "", isFlushing: false, flushCount: 0 }),
  ).map((p) => ({
    ...p,
    queueKey: this.queueKey(p.index),
    inflightKey: this.inflightKey(p.index),
  }));

  /**
   * Apply the current partition flag. Shrinking moves every orphaned
   * partition's pending list into partition 0 so nothing strands; growing
   * needs no migration (new senders simply route to the new keys).
   */
  private async syncPartitions(): Promise<void> {
    const wanted = Math.min(MAX_FLUSH_PARTITIONS, Math.max(1, giftFlushPartitions()));
    if (wanted === this.activePartitions) return;
    const previous = this.activePartitions;
    this.activePartitions = wanted;
    this.logger.info({ from: previous, to: wanted }, "Gift flush partitions changed");
    for (let p = wanted; p < previous; p++) {
      const moved = (await this.redis.eval(
        ATOMIC_MOVE_ALL_LUA,
        2,
        this.queueKey(p),
        this.QUEUE_KEY,
      )) as number;
      if (moved > 0) {
        this.logger.warn({ partition: p, moved }, "Orphaned partition drained into partition 0");
      }
    }
  }

  /** Every partition flushes concurrently; each has its own `isFlushing`. */
  private async flushAll(): Promise<void> {
    try {
      await this.syncPartitions();
    } catch (err) {
      recordRedisDegradation("gift-buffer", "partition-sync");
      this.logger.warn({ err }, "Gift flush partition sync failed — keeping current layout");
    }
    await Promise.all(
      Array.from({ length: this.activePartitions }, (_, p) => this.flush(this.partitions[p]!)),
    );
  }

  /**
   * Flush one partition to Laravel. ticket 05: each partition has its own
   * guard, so a hung backend call on one partition never stalls the others.
   */
  private async flush(part: Partition = this.partitions[0]!): Promise<void> {
    // Prevent concurrent flushes — if a previous batch is still processing
    // (e.g., slow Laravel response), skip this interval tick instead of
    // creating parallel HTTP requests that compound DB contention
    if (part.isFlushing) return;
    part.isFlushing = true;
    const partition = String(part.index);

    // ticket 04: raw claimed strings, kept so in-flight entries can be removed
    // by exact value (LREM) once the backend confirmed, or returned to pending
    // on a Redis-layer error below.
    let claimed: string[] = [];

    try {
    part.flushCount++;

    // gift-authority-tick-fanout 01: sample queue depth once per flush tick —
    // never more often, per the ticket's cap. Wrapped so a Redis hiccup here
    // can never fail the flush it is only observing; pendingCount() already
    // returns -1 (not a throw) on failure, which is skipped rather than
    // published as a bogus negative depth.
    try {
      const depth = await this.pendingCount();
      if (depth >= 0) {
        metrics.giftQueueDepth.set(depth);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to sample gift queue depth");
    }

    // ticket 04: atomically CLAIM up to MAX_BATCH_SIZE items — moved from
    // pending to this instance's in-flight list, not popped into memory.
    // Remaining items stay in pending for the next flush tick.
    const items = await this.redis.eval(
      ATOMIC_CLAIM_N_LUA,
      2,
      part.queueKey,
      part.inflightKey,
      MAX_BATCH_SIZE,
    ) as string[];

    if (!items || items.length === 0) return;
    claimed = items;

    // GF-003 FIX: Per-item JSON parsing with error handling
    // Corrupted entries go to dead-letter instead of poisoning the entire batch
    const transactions: BufferedGift[] = [];
    const rawByTransaction = new Map<string, string>();
    for (const item of items) {
      try {
        const parsed = JSON.parse(item) as BufferedGift;
        transactions.push(parsed);
        rawByTransaction.set(parsed.transaction_id, item);
      } catch {
        this.logger.warn(
          { item: item.slice(0, 200) },
          "Corrupted gift entry, moving to dead letter",
        );
        await this.redis.rpush(this.DEAD_LETTER_KEY, item);
        await this.redis.lrem(part.inflightKey, 1, item);
        metrics.giftsProcessed.inc({ status: "dead_letter" });
      }
    }

    if (transactions.length === 0) {
      return;
    }

    this.logger.info({ count: transactions.length, partition }, "Flushing gift batch");
    metrics.giftBatchSize.observe({ partition }, transactions.length);

    // gift-path-latency 11: how long each gift sat between the sender's emit and
    // this flush picking it up — the first of the three waits on the result path.
    // `gift.timestamp` was stamped by giftHandler on THIS process's clock, and so
    // is `pickedUpAt`, so the difference is a real wait and not clock skew.
    // ⛔ Never subtract a Laravel-side timestamp from either of them.
    // A corrupt or future-dated stamp is skipped rather than observed as negative.
    const pickedUpAt = Date.now();
    for (const gift of transactions) {
      const waitMs = pickedUpAt - gift.timestamp;
      if (Number.isFinite(waitMs) && waitMs >= 0) {
        // A re-queued gift keeps its ORIGINAL timestamp (the fallback path below
        // only bumps retryCount), so its wait spans every failed Laravel round
        // trip too. Label it so the clean batching cost stays readable.
        metrics.giftBufferWaitSeconds.observe(
          { attempt: (gift.retryCount ?? 0) === 0 ? "first" : "retried", partition },
          waitMs / 1000,
        );
      }
    }

    // GF-006 FIX: Report dead-letter queue size for alerting
    // GF-014 FIX: Sample every 10th flush to reduce Redis RTT
    if (part.flushCount % 10 === 0) {
      await this.sampleDeadLetterSize();
    }

    // gift-path-latency 11: hop (d) — the batch POST itself. Timed on BOTH
    // outcomes: a timeout is the slow case this measurement exists to expose, so
    // recording successes only would hide exactly the tail that matters.
    const postStartedAt = Date.now();
    let batchConfirmed = false;

    try {
      const result = await this.laravelClient.processGiftBatch(transactions);
      this.lastBookingOk = true;

      metrics.giftBatchPostSeconds.observe(
        { outcome: "success", partition },
        (Date.now() - postStartedAt) / 1000,
      );

      // ticket 04: the backend confirmed the whole batch (per-item outcomes
      // are inside `result`) — claims are released AFTER this try/catch so a
      // Redis error in the release reaches the outer handler, not the
      // per-item Laravel fallback.
      batchConfirmed = true;

      // Handle failures - notify senders via Socket.IO. batchId lets the FE
      // key its per-burst refund (Laravel's failure rows don't carry it, so
      // map back through the local batch by transaction_id).
      const batchIdByTransaction = new Map(
        transactions.map((t) => [t.transaction_id, t.batch_id]),
      );
      for (const failure of result.failed) {
        if (failure.sender_socket_id) {
          this.io.to(failure.sender_socket_id).emit("gift:error", {
            transactionId: failure.transaction_id,
            code: failure.code, // Error code per protocol
            reason: failure.reason, // Error reason per protocol
            batchId: batchIdByTransaction.get(failure.transaction_id),
          });
        }
        metrics.giftsProcessed.inc({ status: "failed" });
      }

      // Count successes (batch increment instead of loop)
      const successCount = transactions.length - result.failed.length;
      if (successCount > 0) {
        metrics.giftsProcessed.inc({ status: "success" }, successCount);
      }

      // REACT — Epic B ticket 06: push the authoritative post-commit sender
      // balance straight from the batch response, so a lucky cashback shows
      // the moment the batch commits instead of waiting on Laravel's queued
      // realtime bridge. Same payload shape as the bridge's `balance.updated`.
      this.emitSenderBalances(result, transactions);

    } catch (error) {
      this.lastBookingOk = false;
      metrics.giftBatchPostSeconds.observe(
        { outcome: "failure", partition },
        (Date.now() - postStartedAt) / 1000,
      );

      this.logger.error(
        { error, batchSize: transactions.length },
        "Gift batch failed, attempting per-item fallback",
      );

      // Per-item fallback: try sending each item individually.
      // Only items that still fail get re-queued with retryCount++.
      // This prevents one slow/failed transaction from dooming the entire batch.
      const pipeline = this.redis.pipeline();
      let hasDeadLetterEntries = false;

      for (const gift of transactions) {
        // ticket 04: every branch below either books, dead-letters or
        // re-queues this gift — all three release its claim in the same
        // pipeline so the in-flight list never carries a settled item.
        const raw = rawByTransaction.get(gift.transaction_id);
        if (raw !== undefined) pipeline.lrem(part.inflightKey, 1, raw);

        // Try sending as individual 1-item batch
        try {
          const result = await this.laravelClient.processGiftBatch([gift]);
          this.lastBookingOk = true;

          // Handle individual failures from Laravel response
          if (result.failed.length > 0) {
            const fail = result.failed[0];
            if (fail && gift.sender_socket_id) {
              this.io.to(gift.sender_socket_id).emit("gift:error", {
                transactionId: fail.transaction_id,
                code: fail.code,
                reason: fail.reason,
                batchId: gift.batch_id,
              });
            }
            metrics.giftsProcessed.inc({ status: "failed" });
          } else {
            metrics.giftsProcessed.inc({ status: "success" }, 1);
            this.emitSenderBalances(result, [gift]);
          }
          continue; // Item handled, don't re-queue
        } catch {
          // Individual item also failed — fall through to retry/dead-letter logic
        }

        const retryCount = (gift.retryCount ?? 0) + 1;

        if (retryCount >= config.GIFT_MAX_RETRIES) {
          // Move to dead letter queue after max retries
          this.logger.warn(
            { transactionId: gift.transaction_id, retryCount },
            "Gift exceeded max retries, moving to dead letter queue",
          );
          pipeline.rpush(this.DEAD_LETTER_KEY, JSON.stringify(gift));
          hasDeadLetterEntries = true;
          metrics.giftsProcessed.inc({ status: "dead_letter" });

          // Notify sender of permanent failure
          if (gift.sender_socket_id) {
            this.io.to(gift.sender_socket_id).emit("gift:error", {
              transactionId: gift.transaction_id,
              code: "PROCESSING_FAILED",
              reason: "Gift processing failed after multiple attempts",
              batchId: gift.batch_id,
            });
          }
          continue;
        }

        // Re-queue with incremented retry count (same partition)
        gift.retryCount = retryCount;
        pipeline.rpush(part.queueKey, JSON.stringify(gift));
      }

      await pipeline.exec();

      // ticket 04: the destructive trim is no longer unconditional — see
      // sampleDeadLetterSize (alert at 80 %, trim only above the cap, logged).
      if (hasDeadLetterEntries) {
        await this.sampleDeadLetterSize();
      }
    }

    if (batchConfirmed) {
      await this.releaseInflight(
        part,
        transactions.map((t) => rawByTransaction.get(t.transaction_id)),
      );
    }
    } catch (err) {
      // ticket 04: a Redis-layer error anywhere in the flush (claim parsing,
      // pipeline exec, release) — the claimed batch goes back to pending so
      // it is booked by the next tick instead of sitting in in-flight until
      // this instance's next boot. Best effort: if Redis is down the items
      // are still safe in in-flight.
      recordRedisDegradation("gift-buffer", "flush");
      this.logger.error(
        { err, batchSize: claimed.length, partition },
        "Gift flush hit a Redis error — returning claimed batch to pending",
      );
      if (claimed.length > 0) {
        await this.returnToPending(part, claimed);
      }
    } finally {
      part.isFlushing = false;
    }
  }

  /** ticket 04: LREM each confirmed raw entry from the in-flight list. */
  private async releaseInflight(part: Partition, raws: Array<string | undefined>): Promise<void> {
    const pipeline = this.redis.pipeline();
    let any = false;
    for (const raw of raws) {
      if (raw === undefined) continue;
      pipeline.lrem(part.inflightKey, 1, raw);
      any = true;
    }
    if (any) await pipeline.exec();
  }

  /** ticket 04: put claimed raws back on pending and drop their claims. */
  private async returnToPending(part: Partition, raws: string[]): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      for (const raw of raws) {
        pipeline.rpush(part.queueKey, raw);
        pipeline.lrem(part.inflightKey, 1, raw);
      }
      await pipeline.exec();
    } catch (err) {
      this.logger.error(
        { err, count: raws.length, key: part.inflightKey },
        "Gift buffer: could not return claimed batch to pending — items stay in in-flight for boot reclaim",
      );
    }
  }

  /**
   * ticket 04: DLQ size → gauge; error-log + metric above the 80 % high-water
   * mark; trim ONLY above the cap, and log exactly how many were destroyed.
   */
  private async sampleDeadLetterSize(): Promise<void> {
    const dlqSize = await this.redis.llen(this.DEAD_LETTER_KEY);
    metrics.giftDeadLetterSize.set(dlqSize);

    if (dlqSize > DEAD_LETTER_MAX_LENGTH) {
      const trimmed = dlqSize - DEAD_LETTER_MAX_LENGTH;
      await this.redis.ltrim(this.DEAD_LETTER_KEY, -DEAD_LETTER_MAX_LENGTH, -1);
      metrics.giftDeadLetterTrimmed.inc(trimmed);
      this.logger.error(
        { dlqSize, cap: DEAD_LETTER_MAX_LENGTH, trimmed },
        "Gift dead-letter queue ABOVE CAP — oldest entries destroyed",
      );
    } else if (dlqSize > DEAD_LETTER_HIGH_WATER) {
      metrics.giftDeadLetterHighWater.inc();
      this.logger.error(
        { dlqSize, highWater: DEAD_LETTER_HIGH_WATER, cap: DEAD_LETTER_MAX_LENGTH },
        "Gift dead-letter queue above 80% of cap — investigate before trimming starts",
      );
    }
  }

  /**
   * ticket 04: dead-letter consumer. While the last booking call succeeded,
   * replay parked gifts younger than GIFT_PENDING_TTL_MS (runtime flag) back
   * to pending with a fresh retry budget; older ones are dropped with a
   * metric + warn carrying the transaction id. Never runs concurrently with
   * itself; a Redis error is logged and the tick skipped.
   */
  async replayDeadLetters(): Promise<void> {
    if (this.isReplaying || !this.lastBookingOk) return;
    this.isReplaying = true;
    try {
      const items = (await this.redis.eval(
        ATOMIC_LPOP_N_LUA,
        1,
        this.DEAD_LETTER_KEY,
        DEAD_LETTER_REPLAY_BATCH,
      )) as string[];
      if (!items || items.length === 0) return;

      const ttlMs = giftPendingTtlMs();
      const now = Date.now();
      const pipeline = this.redis.pipeline();
      let replayed = 0;
      let expired = 0;

      for (const item of items) {
        let gift: BufferedGift;
        try {
          gift = JSON.parse(item) as BufferedGift;
        } catch {
          expired++;
          metrics.giftDeadLetterExpired.inc();
          this.logger.warn({ item: item.slice(0, 200) }, "Dead-letter entry corrupt — dropped");
          continue;
        }
        const ageMs = now - gift.timestamp;
        if (!Number.isFinite(ageMs) || ageMs > ttlMs) {
          expired++;
          metrics.giftDeadLetterExpired.inc();
          this.logger.warn(
            { transactionId: gift.transaction_id, ageMs, ttlMs, senderId: gift.sender_id },
            "Dead-letter gift older than GIFT_PENDING_TTL_MS — dropped",
          );
          continue;
        }
        gift.retryCount = 0;
        pipeline.rpush(this.queueKeyFor(gift.sender_id), JSON.stringify(gift));
        replayed++;
      }

      if (replayed > 0) {
        await pipeline.exec();
        metrics.giftDeadLetterReplayed.inc(replayed);
      }
      this.logger.info({ replayed, expired, ttlMs }, "Dead-letter consumer tick");
    } catch (err) {
      recordRedisDegradation("gift-buffer", "dead-letter-replay");
      this.logger.warn({ err }, "Dead-letter consumer tick failed — skipped");
    } finally {
      this.isReplaying = false;
    }
  }

  /**
   * REACT (fire-and-forget): relay Laravel's per-group authoritative sender
   * balance snapshots as `balance.updated` to each sender's socket. Matches
   * senders back to sockets via the buffered transactions' sender_socket_id.
   * Absent `processed` (older Laravel) is a silent no-op.
   */
  private emitSenderBalances(
    result: BatchProcessingResult,
    transactions: BufferedGift[],
  ): void {
    try {
      for (const entry of result.processed ?? []) {
        const source = transactions.find((t) =>
          entry.transaction_ids.includes(t.transaction_id),
        );
        if (!source?.sender_socket_id) continue;

        this.io.to(source.sender_socket_id).emit("balance.updated", entry.balance);
      }
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to emit sender balance updates from batch response",
      );
    }
  }
}
