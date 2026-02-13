/**
 * Laravel Event Subscriber
 * Subscribes to Redis pub/sub channel for Laravel events
 *
 * Pattern: Follows GiftBuffer lifecycle (start/stop)
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelEvent } from "./types.js";
import { z } from "zod";

/** Zod schema for incoming Laravel event messages from Redis pub/sub */
const LaravelEventSchema = z.object({
  event: z.string(),
  user_id: z.number().nullable().default(null),
  room_id: z.number().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
  timestamp: z.string().default(() => new Date().toISOString()),
  correlation_id: z.string().default("unknown"),
});


export class LaravelEventSubscriber {
  private subscriber: Redis | null = null;
  private isRunning = false;

  constructor(
    private readonly redis: Redis,
    private readonly channel: string,
    /**
     * Callback invoked for each parsed event. Expected to be synchronous or
     * fire-and-forget async (caller manages its own error handling via .catch()).
     * The subscriber does NOT await this callback.
     */
    private readonly onEvent: (event: LaravelEvent) => void,
    private readonly logger: Logger,
  ) {}

  /**
   * Start subscribing to Laravel events channel
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Event subscriber already running");
      return;
    }

    // Create a duplicate connection for pub/sub
    // (Redis requires separate connection for subscriptions)
    this.subscriber = this.redis.duplicate();

    // Handle connection errors
    this.subscriber.on("error", (err) => {
      this.logger.error({ err }, "Event subscriber Redis error");
    });

    this.subscriber.on("reconnecting", () => {
      this.logger.warn("Event subscriber reconnecting to Redis");
    });

    // Log when subscriber is ready
    this.subscriber.on("ready", () => {
      this.logger.info("Event subscriber Redis connection ready");
    });

    // Handle incoming messages (standard event)
    this.subscriber.on("message", (_channel, message) => {
      this.logger.debug({ messageLength: message.length }, "Redis message received");

      try {
        const event = this.parseEvent(message);
        if (event) {
          this.logger.debug({ event: event.event, user_id: event.user_id }, "Event parsed, routing...");
          this.onEvent(event);
        }
      } catch (err) {
        this.logger.error(
          { err, message: message.substring(0, 200) },
          "Failed to process event message",
        );
      }
    });

    // Subscribe to the channel
    await this.subscriber.subscribe(this.channel);
    this.isRunning = true;

    this.logger.info(
      { channel: this.channel },
      "Laravel event subscriber started",
    );
  }

  /**
   * Stop subscribing and cleanup
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.subscriber) {
      return;
    }

    this.isRunning = false;

    try {
      await this.subscriber.unsubscribe(this.channel);
      await this.subscriber.quit();
      this.subscriber = null;

      this.logger.info("Laravel event subscriber stopped");
    } catch (err) {
      this.logger.error({ err }, "Error stopping event subscriber");
    }
  }

  /**
   * Check if subscriber is currently running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Parse and validate event message
   */
  private parseEvent(message: string): LaravelEvent | null {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.logger.warn(
        { messagePreview: message.substring(0, 100) },
        "Malformed JSON in event message",
      );
      return null;
    }

    const result = LaravelEventSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { errors: result.error.flatten().fieldErrors },
        "Invalid event: schema validation failed",
      );
      return null;
    }

    return result.data;
  }
}
