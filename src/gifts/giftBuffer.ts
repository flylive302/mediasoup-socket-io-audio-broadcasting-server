import type { Server as SocketServer } from 'socket.io';
import type { Redis } from 'ioredis';
import type { Logger } from '../core/logger.js';
import type { LaravelClient } from '../integrations/laravelClient.js';
import type { GiftTransaction } from '../integrations/types.js';

export class GiftBuffer {
  private readonly BATCH_INTERVAL = 500; // ms
  private readonly QUEUE_KEY = 'gifts:pending';
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
    this.timer = setInterval(() => this.flush(), this.BATCH_INTERVAL);
    this.logger.info('Gift buffer started');
  }

  /** Stop the batch processor and flush pending */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Gift buffer stopping, flushing pending items...');
    await this.flush();
    this.logger.info('Gift buffer stopped');
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
      if (errorMessage.toLowerCase().includes('no such key')) {
        return;
      }
      this.logger.error({ error: e }, 'Unexpected error during queue rename');
      return;
    }

    const items = await this.redis.lrange(processingKey, 0, -1);
    if (!items || items.length === 0) {
        await this.redis.del(processingKey);
        return;
    }

    const transactions = items.map(item => JSON.parse(item));
    this.logger.info({ count: transactions.length }, 'Flushing gift batch');

    try {
      const result = await this.laravelClient.processGiftBatch(transactions);

      // Handle failures - notify senders via Socket.IO
      for (const failure of result.failed) {
        if (failure.sender_socket_id) {
            this.io.to(failure.sender_socket_id).emit('gift:error', {
              transactionId: failure.transaction_id,
              code: failure.code,     // Error code per protocol
              reason: failure.reason, // Error reason per protocol
            });
        }
      }
      
      // Success! Delete the temporary key
      await this.redis.del(processingKey);
      
    } catch (error) {
      this.logger.error({ error }, 'Gift batch failed, re-queuing items');
      // Re-queue items to the FRONT of the main queue? Or end?
      // Since it's a buffer, order strictly doesn't matter for *balance*, but matters for history.
      // Append back to main queue
      for (const item of items) {
        await this.redis.rpush(this.QUEUE_KEY, item);
      }
      // Delete processing key
      await this.redis.del(processingKey);
    }
  }
}
