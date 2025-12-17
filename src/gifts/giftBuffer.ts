import type { Server as SocketServer } from "socket.io";
import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";
import type { LaravelClient } from "../integrations/laravelClient.js";
import type { GiftTransaction } from "../integrations/types.js";
import { config } from "../config/index.js";
import { metrics } from "../core/metrics.js";

interface BufferedGift extends GiftTransaction {
  retryCount?: number;
}

export class GiftBuffer {
  private readonly QUEUE_KEY = "gifts:pending";
  private readonly DEAD_LETTER_KEY = "gifts:dead_letter";
  private timer: NodeJS.Timeout | null = null;

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
    // Atomically rename queue to processing key
    // This eliminates race condition between exists() and rename()
    const processingKey = `${this.QUEUE_KEY}:processing:${Date.now()}`;

    try {
      await this.redis.rename(this.QUEUE_KEY, processingKey);
    } catch (e: unknown) {
      // Key doesn't exist (empty queue) or other error
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (errorMessage.toLowerCase().includes("no such key")) {
        return;
      }
      this.logger.error({ error: e }, "Unexpected error during queue rename");
      return;
    }

    const items = await this.redis.lrange(processingKey, 0, -1);
    if (!items || items.length === 0) {
      await this.redis.del(processingKey);
      return;
    }

    const transactions: BufferedGift[] = items.map((item) => JSON.parse(item));
    this.logger.info({ count: transactions.length }, "Flushing gift batch");
    metrics.giftBatchSize.observe(transactions.length);

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

      // Count successes
      const successCount = transactions.length - result.failed.length;
      for (let i = 0; i < successCount; i++) {
        metrics.giftsProcessed.inc({ status: "success" });
      }

      // Success! Delete the temporary key
      await this.redis.del(processingKey);
    } catch (error) {
      this.logger.error(
        { error },
        "Gift batch failed, re-queuing items with retry count",
      );

      // Re-queue items with incremented retry count
      for (const gift of transactions) {
        const retryCount = (gift.retryCount ?? 0) + 1;

        if (retryCount >= config.GIFT_MAX_RETRIES) {
          // Move to dead letter queue after max retries
          this.logger.warn(
            { transactionId: gift.transaction_id, retryCount },
            "Gift exceeded max retries, moving to dead letter queue",
          );
          await this.redis.rpush(this.DEAD_LETTER_KEY, JSON.stringify(gift));
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
        await this.redis.rpush(this.QUEUE_KEY, JSON.stringify(gift));
      }

      // Delete processing key
      await this.redis.del(processingKey);
    }
  }
}
