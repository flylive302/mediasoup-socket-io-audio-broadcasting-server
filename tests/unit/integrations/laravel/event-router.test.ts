import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    JWT_MAX_AGE_SECONDS: 2592000,
    CASCADE_ENABLED: false,
    INTERNAL_API_KEY: "",
    PUBLIC_IP: "",
    PORT: 3030,
    LOG_LEVEL: "silent",
    MAX_SEAT_COUNT: 30,
  },
  isDev: false,
}));

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
import { RELAY_EVENTS } from "@src/integrations/laravel/types.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";

// Helper: create a mock RoomStateRepository
function createMockRoomStateRepo(seatCount = 15) {
  const state = { roomId: "99", seatCount };
  return {
    get: vi.fn().mockResolvedValue(state),
    save: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// Flush the microtask queue so fire-and-forget promise chains (REACT-style,
// not awaited by route()) settle before assertions run.
function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

// Helper: create a mock ClientManager
function createMockClientManager() {
  return {
    updateUserProfile: vi.fn().mockReturnValue(new Set()),
    getClient: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
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
  let clientManager: ReturnType<typeof createMockClientManager>;
  let router: EventRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    io = createMockIO();
    repo = createMockRepo();
    logger = createMockLogger();
    clientManager = createMockClientManager();
    router = new EventRouter(io, repo, clientManager, logger);
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

  // ─── realtime-13 (L2): admin force-close intercept ─────────────

  describe("room.force_close intercept (realtime-13 / L2)", () => {
    it("invokes the force-closer with the room id when this instance hosts the room", async () => {
      const forceCloser = vi.fn().mockResolvedValue(undefined);
      const r = new EventRouter(io, repo, clientManager, logger, undefined as any, undefined, forceCloser);

      const event = createEvent({ event: "room.force_close", room_id: 789, user_id: null });
      const result = await r.route(event);

      expect(result.delivered).toBe(true);
      expect(forceCloser).toHaveBeenCalledWith("789", "admin_force_close");
    });

    it("does not throw when no force-closer is wired (non-hosting path)", async () => {
      const event = createEvent({ event: "room.force_close", room_id: 789, user_id: null });

      await expect(router.route(event)).resolves.toMatchObject({ delivered: true });
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

    it("relays lucky:no-draw user-targeted with the reason payload intact", async () => {
      repo.getSocketIds.mockResolvedValue(["s1"]);

      const event = createEvent({
        event: "lucky:no-draw",
        user_id: 42,
        room_id: null,
        payload: { reason: "user_capped", gift_id: 7, batch_id: "b1" },
      });
      const result = await router.route(event);

      expect(result.delivered).toBe(true);
      expect(repo.getSocketIds).toHaveBeenCalledWith(42);
      // Payload (incl. the new `user_capped` reason) is forwarded opaquely.
      expect(io._toReturnValue.emit).toHaveBeenCalledWith("lucky:no-draw", {
        reason: "user_capped",
        gift_id: 7,
        batch_id: "b1",
      });
    });

    it("allows mission.progress.updated to pass through and routes to the user's sockets", async () => {
      repo.getSocketIds.mockResolvedValue(["socket-1", "socket-2"]);

      const event = createEvent({
        event: "mission.progress.updated",
        user_id: 42,
        room_id: null,
        payload: { milestone_id: 7, timeframe: "daily", instance_key: "daily:2026-06-15" },
      });
      const result = await router.route(event);

      expect(result.delivered).toBe(true);
      expect(repo.getSocketIds).toHaveBeenCalledWith(42);
      expect(io.to).toHaveBeenCalledWith("socket-1");
      expect(io._toReturnValue.to).toHaveBeenCalledWith("socket-2");
      expect(io._toReturnValue.emit).toHaveBeenCalledWith("mission.progress.updated", event.payload);
    });
  });

  // ─── dm-realtime-platform/02: Inbox DM/thread + official events ───

  describe("inbox relay events (dm-realtime-platform/02)", () => {
    it.each([
      "dm.message.received",
      "dm.message.unsent",
      "dm.thread.request",
      "dm.thread.accepted",
      "dm.thread.seen",
      "official.message.received",
    ])("allows %s to pass through and routes to the target user's sockets", async (eventName) => {
      repo.getSocketIds.mockResolvedValue(["socket-1"]);

      const event = createEvent({
        event: eventName,
        user_id: 7,
        room_id: null,
        payload: { threadId: 3 },
      });
      const result = await router.route(event);

      expect(result.delivered).toBe(true);
      expect(repo.getSocketIds).toHaveBeenCalledWith(7);
      expect(io.to).toHaveBeenCalledWith("socket-1");
      expect(io._toReturnValue.emit).toHaveBeenCalledWith(eventName, event.payload);
    });

    it("routes official.message.received to nobody when the target user has no active sockets", async () => {
      repo.getSocketIds.mockResolvedValue([]);

      const event = createEvent({
        event: "official.message.received",
        user_id: 99,
        room_id: null,
        payload: { id: 1, content: "hi", isTargeted: false, isFiltered: false, sentAt: "2026-07-18T00:00:00Z" },
      });
      const result = await router.route(event);

      expect(result.delivered).toBe(false);
      expect(result.targetCount).toBe(0);
    });

    it("broadcasts official.message.received to every connected socket when user_id and room_id are both null", async () => {
      io.sockets.sockets = new Map([
        ["s1", {}],
        ["s2", {}],
      ]);

      const event = createEvent({
        event: "official.message.received",
        user_id: null,
        room_id: null,
        payload: { id: 5, content: "app-wide announcement", isTargeted: false, isFiltered: false, sentAt: "2026-07-18T00:00:00Z" },
      });
      const result = await router.route(event);

      expect(io.emit).toHaveBeenCalledWith("official.message.received", event.payload);
      expect(result.delivered).toBe(true);
      expect(result.targetCount).toBe(2);
    });
  });

  // ─── room-seat-caps/01: syncRoomSettings maxSeats bound ────────

  describe("syncRoomSettings maxSeats bound (room-seat-caps/01)", () => {
    function routeRoomUpdated(
      roomStateRepo: ReturnType<typeof createMockRoomStateRepo>,
      maxSeats: unknown,
    ) {
      const localRouter = new EventRouter(
        io,
        repo,
        clientManager,
        logger,
        undefined as any, // redis — unused by syncRoomSettings itself
        roomStateRepo,
      );
      const event = createEvent({
        event: RELAY_EVENTS.room.ROOM_UPDATED,
        user_id: null,
        room_id: 99,
        payload: { room: { max_seats: maxSeats } },
      });
      return localRouter.route(event);
    }

    it.each([16, 20, 25, 30])(
      "accepts a grown maxSeats of %i and syncs seatCount",
      async (maxSeats) => {
        const roomStateRepo = createMockRoomStateRepo(15);

        await routeRoomUpdated(roomStateRepo, maxSeats);
        await flushPromises();

        expect(roomStateRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({
            seatCount: maxSeats,
            // room-battery-perf/05: the relay stamps itself as the seat-count
            // authority so a joiner's payload can never overwrite it.
            seatCountSource: "laravel",
          }),
        );
      },
    );

    // room-battery-perf/05: an unchanged value still stamps the source so a
    // pending "default" (room created, no join yet) is locked once Laravel
    // has spoken.
    it("stamps seatCountSource 'laravel' even when the value is unchanged", async () => {
      const roomStateRepo = createMockRoomStateRepo(15);

      await routeRoomUpdated(roomStateRepo, 15);
      await flushPromises();

      expect(roomStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ seatCount: 15, seatCountSource: "laravel" }),
      );
    });

    it.each([31, 0, "20", null, undefined])(
      "rejects an out-of-bounds/non-numeric maxSeats of %o",
      async (maxSeats) => {
        const roomStateRepo = createMockRoomStateRepo(15);

        await routeRoomUpdated(roomStateRepo, maxSeats);
        await flushPromises();

        expect(roomStateRepo.save).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ roomId: "99", maxSeats }),
          "Rejected out-of-bounds maxSeats from room.updated",
        );
      },
    );
  });

  // ─── room-seat-caps/02: shrink eviction wiring ─────────────────
  describe("syncRoomSettings shrink eviction (room-seat-caps/02)", () => {
    function createMockRoomManager() {
      return { evictShrunkSeats: vi.fn().mockResolvedValue(undefined) } as any;
    }

    function routeRoomUpdated(
      roomStateRepo: ReturnType<typeof createMockRoomStateRepo>,
      roomManager: ReturnType<typeof createMockRoomManager> | undefined,
      maxSeats: number,
    ) {
      const localRouter = new EventRouter(
        io,
        repo,
        clientManager,
        logger,
        undefined as any,
        roomStateRepo,
        undefined,
        roomManager,
      );
      const event = createEvent({
        event: RELAY_EVENTS.room.ROOM_UPDATED,
        user_id: null,
        room_id: 99,
        payload: { room: { max_seats: maxSeats } },
      });
      return localRouter.route(event);
    }

    it("calls roomManager.evictShrunkSeats when maxSeats is LOWER than the current seatCount", async () => {
      const roomStateRepo = createMockRoomStateRepo(15);
      const roomManager = createMockRoomManager();

      await routeRoomUpdated(roomStateRepo, roomManager, 10);
      await flushPromises();

      expect(roomManager.evictShrunkSeats).toHaveBeenCalledWith("99", 10, clientManager);
    });

    it("never calls evictShrunkSeats when maxSeats is HIGHER (grow path emits no eviction)", async () => {
      const roomStateRepo = createMockRoomStateRepo(15);
      const roomManager = createMockRoomManager();

      await routeRoomUpdated(roomStateRepo, roomManager, 20);
      await flushPromises();

      expect(roomManager.evictShrunkSeats).not.toHaveBeenCalled();
    });

    it("never calls evictShrunkSeats when maxSeats is unchanged", async () => {
      const roomStateRepo = createMockRoomStateRepo(15);
      const roomManager = createMockRoomManager();

      await routeRoomUpdated(roomStateRepo, roomManager, 15);
      await flushPromises();

      expect(roomManager.evictShrunkSeats).not.toHaveBeenCalled();
    });

    it("still saves the shrunk seatCount when roomManager is unset (no eviction, no throw)", async () => {
      const roomStateRepo = createMockRoomStateRepo(15);

      await routeRoomUpdated(roomStateRepo, undefined, 10);
      await flushPromises();

      expect(roomStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ seatCount: 10 }),
      );
    });

    it("logs a warning (never throws) when eviction rejects", async () => {
      const roomStateRepo = createMockRoomStateRepo(15);
      const roomManager = {
        evictShrunkSeats: vi.fn().mockRejectedValue(new Error("redis down")),
      } as any;

      await routeRoomUpdated(roomStateRepo, roomManager, 10);
      await flushPromises();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: "99", newSeatCount: 10 }),
        "Failed to evict shrunk seats",
      );
    });
  });
});
