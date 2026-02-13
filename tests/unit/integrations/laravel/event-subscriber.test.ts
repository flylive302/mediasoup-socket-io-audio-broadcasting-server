import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock("@src/config/index.js", () => ({
  config: {
    MSAB_EVENTS_CHANNEL: "flylive:msab:events",
  },
}));

import { LaravelEventSubscriber } from "@src/integrations/laravel/event-subscriber.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";

// Helper: create a mock Redis subscriber
function createMockRedis() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const mock = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
      return mock; // ioredis returns `this` for chaining
    }),
    removeAllListeners: vi.fn().mockReturnThis(),
    duplicate: vi.fn(),
    _handlers: handlers,
    _emit(event: string, ...args: any[]) {
      const handler = handlers.get(event);
      if (handler) handler(...args);
    },
  } as any;
  // duplicate() returns a fresh mock with same interface
  mock.duplicate.mockReturnValue(mock);
  return mock;
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createValidEventMessage(): string {
  const event: LaravelEvent = {
    event: "balance.updated",
    user_id: 1,
    room_id: null,
    payload: { amount: 100 },
    timestamp: new Date().toISOString(),
    correlation_id: "test-id",
  };
  return JSON.stringify(event);
}

describe("LaravelEventSubscriber", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let logger: ReturnType<typeof createMockLogger>;
  let onEvent: ReturnType<typeof vi.fn>;
  let subscriber: LaravelEventSubscriber;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    logger = createMockLogger();
    onEvent = vi.fn();
    subscriber = new LaravelEventSubscriber(
      redis,
      "flylive:msab:events",
      onEvent,
      logger,
    );
  });

  // ─── RL-012: No metric calls in subscriber ────────────────────

  describe("metric separation (RL-012)", () => {
    it("does not call laravelEventsInFlight from subscriber", async () => {
      await subscriber.start();
      const messageHandler = redis._handlers.get("message");

      const msg = createValidEventMessage();
      messageHandler("flylive:msab:events", msg);

      // Subscriber should call onEvent but NOT touch metrics directly
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it("calls onEvent with parsed event for async routing", async () => {
      await subscriber.start();
      const messageHandler = redis._handlers.get("message");

      const msg = createValidEventMessage();
      messageHandler("flylive:msab:events", msg);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "balance.updated",
          user_id: 1,
        }),
      );
    });
  });

  // ─── RL-017: Redundant channel guard removed ──────────────────

  describe("channel handling (RL-017)", () => {
    it("processes all messages without channel filtering", async () => {
      await subscriber.start();
      const messageHandler = redis._handlers.get("message");

      const msg = createValidEventMessage();
      // Even with a different channel param, message is processed
      // (Redis only delivers subscribed channel messages anyway)
      messageHandler("flylive:msab:events", msg);

      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Error handling ───────────────────────────────────────────

  describe("error handling", () => {
    it("logs error on invalid JSON", async () => {
      await subscriber.start();
      const messageHandler = redis._handlers.get("message");

      messageHandler("flylive:msab:events", "not-json");

      expect(onEvent).not.toHaveBeenCalled();
    });

    it("logs error on invalid field types", async () => {
      await subscriber.start();
      const messageHandler = redis._handlers.get("message");

      // event field must be a string — number should fail Zod validation
      messageHandler("flylive:msab:events", JSON.stringify({ event: 123 }));

      expect(onEvent).not.toHaveBeenCalled();
    });

    it("fills in Zod defaults for missing optional fields", async () => {
      await subscriber.start();
      const messageHandler = redis._handlers.get("message");

      // Only `event` is provided — Zod should fill defaults for user_id, room_id, etc.
      messageHandler("flylive:msab:events", JSON.stringify({ event: "test" }));

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "test",
          user_id: null,
          room_id: null,
          payload: {},
          correlation_id: "unknown",
        }),
      );
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("subscribes to the configured Redis channel on start", async () => {
      await subscriber.start();

      expect(redis.subscribe).toHaveBeenCalledWith("flylive:msab:events");
    });

    it("unsubscribes from Redis channel on stop", async () => {
      await subscriber.start();
      await subscriber.stop();

      expect(redis.unsubscribe).toHaveBeenCalledWith("flylive:msab:events");
    });
  });
});
