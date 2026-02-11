/**
 * Laravel Event Subscriber
 * Subscribes to Redis pub/sub channel for Laravel events
 *
 * Pattern: Follows GiftBuffer lifecycle (start/stop)
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelEvent } from "./types.js";
import { metrics } from "@src/infrastructure/metrics.js";

const BACKPRESSURE_THRESHOLD = 50;

export class LaravelEventSubscriber {
  private subscriber: Redis | null = null;
  private isRunning = false;
  private inFlightCount = 0;

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

      const startTime = Date.now();
      metrics.laravelEventsInFlight.inc();
      this.inFlightCount++;

      try {
        const event = this.parseEvent(message);
        if (event) {
          this.logger.debug({ event: event.event, user_id: event.user_id }, "Event parsed, routing...");
          this.onEvent(event);

          const durationSec = (Date.now() - startTime) / 1000;
          metrics.laravelEventProcessingDuration.observe(
            { event_type: event.event },
            durationSec,
          );
        }
      } catch (err) {
        this.logger.error(
          { err, message: message.substring(0, 200) },
          "Failed to process event message",
        );
      } finally {
        metrics.laravelEventsInFlight.dec();
        this.inFlightCount--;

        if (this.inFlightCount > BACKPRESSURE_THRESHOLD) {
          this.logger.warn(
            { inFlight: this.inFlightCount, threshold: BACKPRESSURE_THRESHOLD },
            "Laravel event subscriber backpressure detected",
          );
        }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.logger.warn(
        { messagePreview: message.substring(0, 100) },
        "Malformed JSON in event message",
      );
      return null;
    }

    // Basic validation
    if (typeof parsed !== "object" || parsed === null) {
      this.logger.warn("Invalid event: not an object");
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.event !== "string") {
      this.logger.warn("Invalid event: missing event type");
      return null;
    }

    // Validate user_id and room_id types
    if (obj.user_id !== null && typeof obj.user_id !== "number") {
      this.logger.warn({ user_id: obj.user_id }, "Invalid user_id type");
      return null;
    }

    if (obj.room_id !== null && typeof obj.room_id !== "number") {
      this.logger.warn({ room_id: obj.room_id }, "Invalid room_id type");
      return null;
    }

    return {
      event: obj.event as string,
      user_id: (obj.user_id as number) ?? null,
      room_id: (obj.room_id as number) ?? null,
      payload: (obj.payload as Record<string, unknown>) ?? {},
      timestamp: (obj.timestamp as string) ?? new Date().toISOString(),
      correlation_id: (obj.correlation_id as string) ?? "unknown",
    };
  }
}
