/**
 * Laravel Event Subscriber
 * Subscribes to Redis pub/sub channel for Laravel events
 *
 * Pattern: Follows GiftBuffer lifecycle (start/stop)
 */
import type { Redis } from "ioredis";
import type { Logger } from "../../infrastructure/logger.js";
import type { LaravelEvent } from "./types.js";

export class LaravelEventSubscriber {
  private subscriber: Redis | null = null;
  private isRunning = false;

  constructor(
    private readonly redis: Redis,
    private readonly channel: string,
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
    this.subscriber.on("message", (channel, message) => {
      this.logger.debug({ channel, messageLength: message.length }, "Redis message received");
      
      if (channel !== this.channel) return;

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

    // Some ioredis versions use messageBuffer instead
    this.subscriber.on("messageBuffer", (_channel, _message) => {
      this.logger.debug("Redis messageBuffer received (buffer mode)");
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
    const parsed = JSON.parse(message);

    // Basic validation
    if (typeof parsed !== "object" || parsed === null) {
      this.logger.warn("Invalid event: not an object");
      return null;
    }

    if (typeof parsed.event !== "string") {
      this.logger.warn("Invalid event: missing event type");
      return null;
    }

    // Validate user_id and room_id types
    if (parsed.user_id !== null && typeof parsed.user_id !== "number") {
      this.logger.warn({ user_id: parsed.user_id }, "Invalid user_id type");
      return null;
    }

    if (parsed.room_id !== null && typeof parsed.room_id !== "number") {
      this.logger.warn({ room_id: parsed.room_id }, "Invalid room_id type");
      return null;
    }

    return {
      event: parsed.event,
      user_id: parsed.user_id ?? null,
      room_id: parsed.room_id ?? null,
      payload: parsed.payload ?? {},
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      correlation_id: parsed.correlation_id ?? "unknown",
    };
  }
}
