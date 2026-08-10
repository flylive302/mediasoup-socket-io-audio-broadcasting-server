/**
 * SQS Queue Consumer — second transport into the event-ingest seam (ticket 26)
 *
 * Pulls Laravel economy events off the msab-events FIFO queue (ticket 25,
 * shape per ADR 0029) and hands every message body to the SAME
 * envelope-handling pipeline the HTTP route uses (`ingestEnvelope`,
 * event-ingest.ts). No second ingest path exists — transport divergence is
 * impossible to express, not merely discouraged.
 *
 * Transport semantics (how IngestOutcome maps onto the queue):
 *   ok / duplicate → DeleteMessage. Both are terminal: routed, or already
 *                    routed once (at-least-once redelivery is normal).
 *   invalid        → NOT deleted. A schema-invalid body will never succeed;
 *                    after maxReceiveCount (5, ticket 25) SQS dead-letters it
 *                    for an operator instead of silently discarding it.
 *   capacity       → NOT deleted, stop working the batch. Redelivery after
 *                    the visibility timeout IS the backpressure — the burst
 *                    shows up as queue depth, not dropped events.
 *   routing throw  → NOT deleted (dedup claim already released by the seam).
 *
 * Messages are processed SEQUENTIALLY within a batch: SQS FIFO delivers a
 * message group in order, and concurrent handling inside the batch would
 * reorder it — the whole point of the FIFO shape.
 *
 * Authentication is the instance's IAM role via the SDK default credential
 * chain (consume-only policy, modules/iam) — no shared secret, no header key.
 *
 * INERT unless EVENT_QUEUE_URL is set (unset in production until cutover).
 */
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import type { Redis } from "ioredis";
import type { EventRouter } from "@src/integrations/laravel/event-router.js";
import type { Logger } from "./logger.js";
import { config } from "@src/config/index.js";
import { ingestEnvelope } from "./event-ingest.js";

/** Long-poll duration. 20s is the SQS maximum — fewest empty receives. */
const WAIT_TIME_SECONDS = 20;
/** SQS batch maximum. */
const MAX_MESSAGES_PER_RECEIVE = 10;
/** Backoff after a receive/network error so a broken queue can't spin-loop. */
const RECEIVE_ERROR_BACKOFF_MS = 5_000;

export class QueueConsumer {
  private readonly client: SQSClient;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly queueUrl: string,
    private readonly eventRouter: EventRouter,
    private readonly logger: Logger,
    private readonly redis?: Redis,
    client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({ region: config.AWS_REGION });
  }

  /** Begin the long-poll loop. Safe to call once; no-op if already started. */
  start(): void {
    if (this.loopPromise) return;
    this.logger.info(
      { queueUrl: this.queueUrl },
      "Queue consumer started (SQS FIFO, IAM-role auth)",
    );
    this.loopPromise = this.runLoop();
  }

  /**
   * Graceful shutdown: stop polling, abort the in-flight long poll, and wait
   * for the current batch to finish routing. Bounded by the caller — this
   * runs inside the app's own shutdown ceiling (index.ts, the F-5 drain
   * ceiling ticket 18 derives everything from); per-message routing is
   * milliseconds, so draining one batch is far inside that window.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abortController?.abort();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    this.logger.info("Queue consumer stopped (in-flight batch drained)");
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[] | undefined;

      this.abortController = new AbortController();
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            WaitTimeSeconds: WAIT_TIME_SECONDS,
            MaxNumberOfMessages: MAX_MESSAGES_PER_RECEIVE,
          }),
          { abortSignal: this.abortController.signal },
        );
        messages = response.Messages;
      } catch (err) {
        if (this.stopping) return; // aborted by stop() — not an error
        this.logger.warn(
          { err },
          "Queue consumer: receive failed — backing off",
        );
        await this.sleepUnlessStopping(RECEIVE_ERROR_BACKOFF_MS);
        continue;
      } finally {
        this.abortController = null;
      }

      if (!messages?.length) continue;

      // Sequential on purpose — preserves FIFO group order within the batch.
      for (const message of messages) {
        // A stop() during the batch finishes the CURRENT message (routing is
        // in flight) but does not start the next — undeleted messages simply
        // redeliver after the visibility timeout. At-least-once, by design.
        if (this.stopping) return;
        const done = await this.processMessage(message);
        // capacity: leave the rest of the batch undeleted and back off.
        if (!done) {
          await this.sleepUnlessStopping(1_000);
          break;
        }
      }
    }
  }

  /**
   * Handle one message through the shared ingest seam.
   * Returns false only for the capacity outcome (stop working the batch).
   */
  private async processMessage(message: Message): Promise<boolean> {
    let raw: unknown;
    try {
      raw = JSON.parse(message.Body ?? "");
    } catch {
      // Unparseable body: same fate as schema-invalid — never deleted here,
      // dead-letters after maxReceiveCount for an operator to inspect.
      this.logger.warn(
        { messageId: message.MessageId },
        "Queue consumer: message body is not JSON — leaving for DLQ",
      );
      return true;
    }

    try {
      const outcome = await ingestEnvelope(raw, {
        eventRouter: this.eventRouter,
        ...(this.redis ? { redis: this.redis } : {}),
        log: this.logger,
      });

      switch (outcome.kind) {
        case "ok":
        case "duplicate":
          await this.deleteMessage(message);
          return true;
        case "invalid":
          this.logger.warn(
            { messageId: message.MessageId, errors: outcome.errors },
            "Queue consumer: schema-invalid envelope — leaving for DLQ",
          );
          return true;
        case "capacity":
          return false;
      }
    } catch (err) {
      // Routing threw (claim already released by the seam): keep the message
      // for redelivery; five failures dead-letter it.
      this.logger.warn(
        { err, messageId: message.MessageId },
        "Queue consumer: routing failed — leaving message for redelivery",
      );
      return true;
    }
  }

  private async deleteMessage(message: Message): Promise<void> {
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (err) {
      // Delete failure = the message redelivers and the dedup gate suppresses
      // it. Log and continue — at-least-once absorbs this.
      this.logger.warn(
        { err, messageId: message.MessageId },
        "Queue consumer: delete failed — dedup will absorb the redelivery",
      );
    }
  }

  private sleepUnlessStopping(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // Don't hold the process open for a backoff timer.
      if (typeof t.unref === "function") t.unref();
    });
  }
}

/**
 * Factory honouring the inert-by-default rule: no EVENT_QUEUE_URL, no
 * consumer, production behaviour unchanged (memory: ship infra inert).
 */
export function createQueueConsumer(deps: {
  eventRouter: EventRouter;
  logger: Logger;
  redis?: Redis;
}): QueueConsumer | null {
  if (!config.EVENT_QUEUE_URL) return null;
  return new QueueConsumer(
    config.EVENT_QUEUE_URL,
    deps.eventRouter,
    deps.logger,
    deps.redis,
  );
}
