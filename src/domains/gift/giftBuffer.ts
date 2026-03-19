import type { Server as SocketServer } from "socket.io";
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { GiftTransaction } from "@src/integrations/types.js";
import { config } from "@src/config/index.js";
import { metrics } from "@src/infrastructure/metrics.js";

/**
 * Max transactions per flush — prevents large accumulated batches from
 * causing HTTP timeouts. Remaining items stay in the queue for the next tick.
 */
const MAX_BATCH_SIZE = 50;

/**
 * Lua script: atomically pop up to N items from the left of a list.
 * Returns the popped items as an array, or an empty array if the list is empty.
 * This is more efficient than LPOP in a loop (single round-trip).
 */
const ATOMIC_LPOP_N_LUA = `
  local items = redis.call('lrange', KEYS[1], 0, ARGV[1] - 1)
  if #items > 0 then
    redis.call('ltrim', KEYS[1], #items, -1)
  end
  return items
`;

interface BufferedGift extends GiftTransaction {
  retryCount?: number;
}

// GF-006 FIX: Cap dead-letter queue to prevent unbounded Redis memory growth
const DEAD_LETTER_MAX_LENGTH = 10_000;

export class GiftBuffer {
  private readonly QUEUE_KEY = "gifts:pending";
  private readonly DEAD_LETTER_KEY = "gifts:dead_letter";
  private timer: NodeJS.Timeout | null = null;
  private flushCount = 0;
  private isFlushing = false;

  constructor(
    private readonly redis: Redis,
    private readonly laravelClient: LaravelClient,
    private readonly io: SocketServer,
    private readonly logger: Logger,
  ) {}

  /** Start the batch processor */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.flush(),
      config.GIFT_BUFFER_FLUSH_INTERVAL_MS,
    );
    this.logger.info(
      { intervalMs: config.GIFT_BUFFER_FLUSH_INTERVAL_MS },
      "Gift buffer started",
    );
  }

  /** Stop the batch processor and flush pending */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("Gift buffer stopping, flushing pending items...");
    await this.flush();
    this.logger.info("Gift buffer stopped");
  }

  /** Add gift to buffer (called on each gift event) */
  async enqueue(gift: GiftTransaction): Promise<void> {
    await this.redis.rpush(this.QUEUE_KEY, JSON.stringify(gift));
  }

  /** Flush buffer to Laravel */
  private async flush(): Promise<void> {
    // Prevent concurrent flushes — if a previous batch is still processing
    // (e.g., slow Laravel response), skip this interval tick instead of
    // creating parallel HTTP requests that compound DB contention
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
    this.flushCount++;

    // Atomically pop up to MAX_BATCH_SIZE items from the queue.
    // Remaining items stay in the queue for the next flush tick.
    // This prevents unbounded batch sizes that cause HTTP timeouts.
    const items = await this.redis.eval(
      ATOMIC_LPOP_N_LUA,
      1,
      this.QUEUE_KEY,
      MAX_BATCH_SIZE,
    ) as string[];

    if (!items || items.length === 0) return;

    // GF-003 FIX: Per-item JSON parsing with error handling
    // Corrupted entries go to dead-letter instead of poisoning the entire batch
    const transactions: BufferedGift[] = [];
    for (const item of items) {
      try {
        transactions.push(JSON.parse(item) as BufferedGift);
      } catch {
        this.logger.warn(
          { item: item.slice(0, 200) },
          "Corrupted gift entry, moving to dead letter",
        );
        await this.redis.rpush(this.DEAD_LETTER_KEY, item);
        metrics.giftsProcessed.inc({ status: "dead_letter" });
      }
    }

    if (transactions.length === 0) {
      return;
    }

    this.logger.info({ count: transactions.length }, "Flushing gift batch");
    metrics.giftBatchSize.observe(transactions.length);

    // GF-006 FIX: Report dead-letter queue size for alerting
    // GF-014 FIX: Sample every 10th flush to reduce Redis RTT
    if (this.flushCount % 10 === 0) {
      const dlqSize = await this.redis.llen(this.DEAD_LETTER_KEY);
      metrics.giftDeadLetterSize.set(dlqSize);
    }

    try {
      const result = await this.laravelClient.processGiftBatch(transactions);

      // Handle failures - notify senders via Socket.IO
      for (const failure of result.failed) {
        if (failure.sender_socket_id) {
          this.io.to(failure.sender_socket_id).emit("gift:error", {
            transactionId: failure.transaction_id,
            code: failure.code, // Error code per protocol
            reason: failure.reason, // Error reason per protocol
          });
        }
        metrics.giftsProcessed.inc({ status: "failed" });
      }

      // Count successes (batch increment instead of loop)
      const successCount = transactions.length - result.failed.length;
      if (successCount > 0) {
        metrics.giftsProcessed.inc({ status: "success" }, successCount);
      }

    } catch (error) {
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
        // Try sending as individual 1-item batch
        try {
          const result = await this.laravelClient.processGiftBatch([gift]);

          // Handle individual failures from Laravel response
          if (result.failed.length > 0) {
            const fail = result.failed[0];
            if (fail && gift.sender_socket_id) {
              this.io.to(gift.sender_socket_id).emit("gift:error", {
                transactionId: fail.transaction_id,
                code: fail.code,
                reason: fail.reason,
              });
            }
            metrics.giftsProcessed.inc({ status: "failed" });
          } else {
            metrics.giftsProcessed.inc({ status: "success" }, 1);
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
            });
          }
          continue;
        }

        // Re-queue with incremented retry count
        gift.retryCount = retryCount;
        pipeline.rpush(this.QUEUE_KEY, JSON.stringify(gift));
      }

      // GF-006 FIX: Cap dead-letter queue once (not per-item) to prevent unbounded growth
      if (hasDeadLetterEntries) {
        pipeline.ltrim(this.DEAD_LETTER_KEY, -DEAD_LETTER_MAX_LENGTH, -1);
      }

      await pipeline.exec();
    }
    } finally {
      this.isFlushing = false;
    }
  }
}
