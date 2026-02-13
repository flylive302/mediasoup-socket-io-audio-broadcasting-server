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

// Mock metrics
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    laravelEventsReceived: { inc: vi.fn() },
    laravelEventsInFlight: { inc: vi.fn(), dec: vi.fn() },
    laravelEventProcessingDuration: { observe: vi.fn() },
  },
}));

import { EventRouter } from "@src/integrations/laravel/event-router.js";
import { metrics } from "@src/infrastructure/metrics.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";

// Helper: create a mock Socket.IO server
function createMockIO() {
  const emitFn = vi.fn();
  const toReturnValue = { emit: emitFn, to: vi.fn() };
  // Chain .to() calls
  toReturnValue.to = vi.fn().mockReturnValue(toReturnValue);

  return {
    to: vi.fn().mockReturnValue(toReturnValue),
    emit: vi.fn(),
    sockets: {
      sockets: new Map([["local-socket-1", {}]]),
      adapter: {
        rooms: new Map<string, Set<string>>(),
      },
    },
    _emitFn: emitFn,
    _toReturnValue: toReturnValue,
  } as any;
}

// Helper: create a mock UserSocketRepository
function createMockRepo() {
  return {
    getSocketIds: vi.fn().mockResolvedValue([]),
    registerSocket: vi.fn().mockResolvedValue(true),
    unregisterSocket: vi.fn().mockResolvedValue(true),
  } as any;
}

// Helper: create a mock logger
function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

// Helper: create a base event
function createEvent(overrides: Partial<LaravelEvent> = {}): LaravelEvent {
  return {
    event: "balance.updated",
    user_id: null,
    room_id: null,
    payload: { amount: 100 },
    timestamp: new Date().toISOString(),
    correlation_id: "test-corr-id",
    ...overrides,
  };
}

describe("EventRouter", () => {
  let io: ReturnType<typeof createMockIO>;
  let repo: ReturnType<typeof createMockRepo>;
  let logger: ReturnType<typeof createMockLogger>;
  let router: EventRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    io = createMockIO();
    repo = createMockRepo();
    logger = createMockLogger();
    router = new EventRouter(io, repo, logger);
  });

  // ─── RL-011: Multi-instance room emit ──────────────────────────

  describe("emitToRoom (RL-011)", () => {
    it("emits unconditionally even with empty local room", async () => {
      // Room has NO local sockets — previously this would drop the event
      io.sockets.adapter.rooms = new Map();

      const event = createEvent({ room_id: 123, user_id: null });
      const result = await router.route(event);

      // io.to(roomId).emit() should still be called
      expect(io.to).toHaveBeenCalledWith("123");
      expect(result.delivered).toBe(true);
    });

    it("reports local socket count as targetCount", async () => {
      io.sockets.adapter.rooms.set("456", new Set(["s1", "s2"]));

      const event = createEvent({ room_id: 456, user_id: null });
      const result = await router.route(event);

      expect(result.targetCount).toBe(2);
    });
  });

  describe("emitToUserInRoom / user_in_room target (NR-002)", () => {
    it("routes user_in_room via emitToUser (roomId is informational)", async () => {
      repo.getSocketIds.mockResolvedValue(["socket-a", "socket-b"]);
      // Room does NOT exist locally — previously would early-return
      io.sockets.adapter.rooms = new Map();

      const event = createEvent({ user_id: 42, room_id: 100 });
      const result = await router.route(event);

      expect(result.delivered).toBe(true);
      expect(result.targetCount).toBe(2);
    });

    it("returns delivered=false when user has no sockets", async () => {
      repo.getSocketIds.mockResolvedValue([]);

      const event = createEvent({ user_id: 42, room_id: 100 });
      const result = await router.route(event);

      expect(result.delivered).toBe(false);
      expect(result.targetCount).toBe(0);
    });
  });

  // ─── RL-018: emitToAll local count ────────────────────────────

  describe("emitToAll (RL-018)", () => {
    it("emits globally and reports local socket count", async () => {
      io.sockets.sockets = new Map([
        ["s1", {}],
        ["s2", {}],
        ["s3", {}],
      ]);

      const event = createEvent({ user_id: null, room_id: null });
      const result = await router.route(event);

      expect(io.emit).toHaveBeenCalledWith("balance.updated", { amount: 100 });
      expect(result.delivered).toBe(true);
      expect(result.targetCount).toBe(3);
    });
  });

  // ─── RL-012: In-flight gauge in route() ───────────────────────

  describe("observability (RL-012)", () => {
    it("increments/decrements in-flight gauge around route()", async () => {
      const event = createEvent({ user_id: null, room_id: null });
      await router.route(event);

      expect(metrics.laravelEventsInFlight.inc).toHaveBeenCalledTimes(1);
      expect(metrics.laravelEventsInFlight.dec).toHaveBeenCalledTimes(1);
    });

    it("records duration metric including async work", async () => {
      repo.getSocketIds.mockResolvedValue(["s1"]);

      const event = createEvent({ user_id: 42, room_id: null });
      await router.route(event);

      expect(metrics.laravelEventProcessingDuration.observe).toHaveBeenCalledWith(
        { event_type: "balance.updated" },
        expect.any(Number),
      );
    });

    it("decrements in-flight gauge even on error", async () => {
      repo.getSocketIds.mockRejectedValue(new Error("Redis down"));

      const event = createEvent({ user_id: 42, room_id: null });
      await router.route(event);

      expect(metrics.laravelEventsInFlight.dec).toHaveBeenCalledTimes(1);
    });
  });

  // ─── RL-014: Error-path metric ────────────────────────────────

  describe("error-path counter (RL-014)", () => {
    it("increments counter with delivered='error' on routing failure", async () => {
      repo.getSocketIds.mockRejectedValue(new Error("Redis exploded"));

      const event = createEvent({ user_id: 42, room_id: null });
      await router.route(event);

      expect(metrics.laravelEventsReceived.inc).toHaveBeenCalledWith({
        event_type: "balance.updated",
        delivered: "error",
      });
    });
  });

  // ─── Routing target determination ─────────────────────────────

  describe("determineTarget", () => {
    it("routes to user when only user_id is set", async () => {
      repo.getSocketIds.mockResolvedValue(["s1"]);

      const event = createEvent({ user_id: 5, room_id: null });
      await router.route(event);

      expect(repo.getSocketIds).toHaveBeenCalledWith(5);
    });

    it("routes to room when only room_id is set", async () => {
      const event = createEvent({ user_id: null, room_id: 99 });
      await router.route(event);

      expect(io.to).toHaveBeenCalledWith("99");
    });

    it("routes to user_in_room when both are set", async () => {
      repo.getSocketIds.mockResolvedValue(["s1"]);

      const event = createEvent({ user_id: 5, room_id: 99 });
      await router.route(event);

      expect(repo.getSocketIds).toHaveBeenCalledWith(5);
    });

    it("broadcasts when both are null", async () => {
      const event = createEvent({ user_id: null, room_id: null });
      await router.route(event);

      expect(io.emit).toHaveBeenCalled();
    });
  });

  // ─── Allowlist gate ────────────────────────────────────────────

  describe("allowlist gate", () => {
    it("rejects unknown events with error and rejected metric", async () => {
      const event = createEvent({ event: "totally.unknown.event" });
      const result = await router.route(event);

      expect(result.delivered).toBe(false);
      expect(result.error).toBe("Unknown event");
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "totally.unknown.event" }),
        expect.stringContaining("Unknown relay event"),
      );
      expect(metrics.laravelEventsReceived.inc).toHaveBeenCalledWith({
        event_type: "unknown",
        delivered: "rejected",
      });
    });

    it("does not increment in-flight gauge for rejected events", async () => {
      const event = createEvent({ event: "not.registered" });
      await router.route(event);

      expect(metrics.laravelEventsInFlight.inc).not.toHaveBeenCalled();
    });

    it("allows known events to pass through", async () => {
      const event = createEvent({
        event: "balance.updated",
        user_id: null,
        room_id: null,
      });
      const result = await router.route(event);

      expect(result.delivered).toBe(true);
    });
  });
});
