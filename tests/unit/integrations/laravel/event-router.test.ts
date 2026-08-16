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
    laravelEventsDeduplicated: { inc: vi.fn() },
    laravelEventsStaleRejected: { inc: vi.fn() },
    laravelEventsFanoutSuppressed: { inc: vi.fn() },
    roomBlockMirror: { inc: vi.fn() },
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


// A fan-out claim SET (aws-production 22) is expected on every routed event;
// these ordering-guard tests only care that no MIRROR/WATERMARK write happened.
function expectNoNonClaimSet(redis: any) {
  const nonClaim = redis.set.mock.calls.filter(
    (c: unknown[]) => !String(c[0]).startsWith("msab:ingest:dedup:fanout:"),
  );
  expect(nonClaim).toHaveLength(0);
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

  // ─── ADR 0017 / msab-join-gates 02: room-block Redis mirror ────
  //
  // This is the missing half of the cross-service contract. The Laravel side
  // is pinned by backend `tests/Feature/Room/RoomBlockWireContractTest.php`
  // (literal payload keys on the wire); `room-block.repository.test.ts` pins
  // the literal Redis key. These tests join the two: they prove a real
  // `room.member_removed` envelope, shaped exactly as Laravel emits it,
  // produces the exact key that `room:join`'s GATE reads.
  //
  // Nothing covered this before, which is how a mirror could be *believed*
  // disconnected for a day with no test able to settle the question.
  describe("room-block mirror (ADR 0017)", () => {
    function createMockRedis() {
      return {
        set: vi.fn().mockResolvedValue("OK"),
        del: vi.fn().mockResolvedValue(1),
      } as any;
    }

    function createRouterWithRedis(redis: any) {
      return new EventRouter(io, repo, clientManager, logger, redis);
    }

    it("writes the join-GATE key with a TTL for a timed block", async () => {
      const redis = createMockRedis();

      await createRouterWithRedis(redis).route(
        createEvent({
          event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
          user_id: 42,
          room_id: null,
          // Payload shape is Laravel's, verbatim — see RoomEventEmitter.php
          payload: {
            room_id: 7,
            user_id: 42,
            removed_by: 1,
            duration: "1h",
            banned_until: "2026-07-26T02:00:00+00:00",
            remaining_seconds: 3600,
            permanent: false,
          },
        }),
      );
      await flushPromises();

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 3600);
    });

    it("writes the key with NO TTL for a permanent block", async () => {
      const redis = createMockRedis();

      await createRouterWithRedis(redis).route(
        createEvent({
          event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
          user_id: 42,
          room_id: null,
          payload: {
            room_id: 7,
            user_id: 42,
            removed_by: 1,
            duration: "permanent",
            banned_until: null,
            remaining_seconds: null,
            permanent: true,
          },
        }),
      );
      await flushPromises();

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1");
    });

    it("deletes the key on unblock", async () => {
      const redis = createMockRedis();

      await createRouterWithRedis(redis).route(
        createEvent({
          event: RELAY_EVENTS.room.ROOM_USER_UNBLOCKED,
          user_id: 42,
          room_id: null,
          payload: { room_id: 7, room_name: "Test Room", user_id: 42 },
        }),
      );
      await flushPromises();

      expect(redis.del).toHaveBeenCalledWith("room:7:blocked:42");
    });

    // The mirror write is REACT — a Redis failure must reach Sentry via
    // reactError but must never fail the event route, or one bad mirror
    // write would start rejecting Laravel's whole fanout POST.
    it("never throws out of route() when the mirror write fails", async () => {
      const redis = createMockRedis();
      redis.set.mockRejectedValue(new Error("Redis down"));

      const routing = createRouterWithRedis(redis).route(
        createEvent({
          event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
          user_id: 42,
          room_id: null,
          payload: {
            room_id: 7,
            user_id: 42,
            remaining_seconds: 3600,
            permanent: false,
          },
        }),
      );

      // Resolves rather than rejects — the rejected mirror write is caught by
      // the REACT-stage .catch(reactError) and never surfaces to the caller.
      await expect(routing).resolves.toBeDefined();
      await flushPromises();

      expect(redis.set).toHaveBeenCalled();
    });
  });

  // aws-platform-build/07 — order-sensitivity guards.
  //
  // Delivery is at-least-once TODAY (DeliverRealtimeEvent: $tries=3,
  // $backoff=[2,10,30]), so a failed earlier event can land AFTER a later one.
  // These three event classes applied state unconditionally, so reordering left
  // the wrong terminal state. Each guard is a Redis compare-and-set; the Lua
  // itself cannot run under Vitest (no real Redis in this suite), so `eval` is
  // stubbed with its two outcomes — 1 = accepted, 0 = rejected as stale — and
  // the Lua's own semantics were verified separately against a live Redis.
  describe("ordering guards (aws-platform-build/07)", () => {
    const OLDER = "2026-08-06T00:00:00+00:00";
    const NEWER = "2026-08-06T00:00:30+00:00";

    /** `accepted` drives the guard verdict the same way real Redis would. */
    function createGuardRedis(accepted: boolean) {
      return {
        set: vi.fn().mockResolvedValue("OK"),
        del: vi.fn().mockResolvedValue(1),
        eval: vi.fn().mockResolvedValue(accepted ? 1 : 0),
      } as any;
    }

    function createRoomStateRepo(seatCount: number) {
      return {
        get: vi.fn().mockResolvedValue({
          id: "7",
          seatCount,
          seatCountSource: "laravel",
          participantCount: 3,
        }),
        save: vi.fn().mockResolvedValue(undefined),
      } as any;
    }

    describe("room.updated", () => {
      const shrink = (timestamp: string) =>
        createEvent({
          event: RELAY_EVENTS.room.ROOM_UPDATED,
          room_id: 7,
          user_id: null,
          timestamp,
          payload: { room: { max_seats: 4 } },
        });

      it("evicts on a shrink that is NOT stale (guard accepts)", async () => {
        const redis = createGuardRedis(true);
        const roomStateRepo = createRoomStateRepo(10);
        const roomManager = { evictShrunkSeats: vi.fn().mockResolvedValue(undefined) } as any;

        io.sockets.adapter.rooms.set("7", new Set(["s1"]));
        const router = new EventRouter(
          io, repo, clientManager, logger, redis, roomStateRepo, undefined, roomManager,
        );

        await router.route(shrink(NEWER));
        await flushPromises();
        await flushPromises();

        expect(roomStateRepo.save).toHaveBeenCalled();
        expect(roomManager.evictShrunkSeats).toHaveBeenCalledWith("7", 4, clientManager);
      });

      // The load-bearing case: the shrink branch throws real occupants out of
      // their seats, so replaying a stale room.updated does not merely write a
      // wrong number — it evicts people who legitimately hold those seats.
      it("a stale room.updated neither writes seatCount nor evicts occupants", async () => {
        const redis = createGuardRedis(false);
        const roomStateRepo = createRoomStateRepo(10);
        const roomManager = { evictShrunkSeats: vi.fn().mockResolvedValue(undefined) } as any;

        io.sockets.adapter.rooms.set("7", new Set(["s1"]));
        const router = new EventRouter(
          io, repo, clientManager, logger, redis, roomStateRepo, undefined, roomManager,
        );

        await router.route(shrink(OLDER));
        await flushPromises();
        await flushPromises();

        expect(roomStateRepo.get).not.toHaveBeenCalled();
        expect(roomStateRepo.save).not.toHaveBeenCalled();
        expect(roomManager.evictShrunkSeats).not.toHaveBeenCalled();
        expect(metrics.laravelEventsStaleRejected.inc).toHaveBeenCalledWith({
          event_type: RELAY_EVENTS.room.ROOM_UPDATED,
        });
      });

      it("applies the update when the envelope carries no timestamp to compare", async () => {
        const redis = createGuardRedis(false); // would reject, but must not be consulted
        const roomStateRepo = createRoomStateRepo(10);

        io.sockets.adapter.rooms.set("7", new Set(["s1"]));
        const router = new EventRouter(
          io, repo, clientManager, logger, redis, roomStateRepo,
        );

        const { timestamp: _dropped, ...noTimestamp } = shrink(NEWER);
        await router.route(noTimestamp as any);
        await flushPromises();
        await flushPromises();

        expect(redis.eval).not.toHaveBeenCalled();
        expect(roomStateRepo.save).toHaveBeenCalled();
      });
    });

    describe("room.member_removed / room.user_unblocked", () => {
      const blockEvent = (timestamp: string) =>
        createEvent({
          event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
          user_id: 42,
          room_id: null,
          timestamp,
          payload: { room_id: 7, user_id: 42, remaining_seconds: 3600, permanent: false },
        });

      const unblockEvent = (timestamp: string) =>
        createEvent({
          event: RELAY_EVENTS.room.ROOM_USER_UNBLOCKED,
          user_id: 42,
          room_id: null,
          timestamp,
          payload: { room_id: 7, user_id: 42 },
        });

      it("a block delayed behind the unblock that supersedes it does NOT re-lock the user", async () => {
        const redis = createGuardRedis(false);

        await new EventRouter(io, repo, clientManager, logger, redis).route(blockEvent(OLDER));
        await flushPromises();

        expectNoNonClaimSet(redis);
        expect(metrics.laravelEventsStaleRejected.inc).toHaveBeenCalledWith({
          event_type: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
        });
      });

      /**
       * The mirror write and the seat ejection must share ONE verdict.
       * Gating only the mirror would let a stale block still throw the user off
       * their seat while writing no block — a visible eviction with no state
       * behind it, so the user simply rejoins. Partial application is exactly
       * what AC #3's "correct terminal state" forbids.
       */
      it("a stale block ejects nobody from their seat, not just skips the mirror", async () => {
        const redis = createGuardRedis(false);
        // `leaveSeat` is ejectRoomMember's very first step — if it is untouched,
        // no part of the ejection ran.
        const seatRepository = { leaveSeat: vi.fn() } as any;
        const roomStateRepo = { get: vi.fn(), save: vi.fn() } as any;
        const statusCoalescer = { schedule: vi.fn() } as any;
        const userRoomRepository = { get: vi.fn(), clear: vi.fn() } as any;

        const router = new EventRouter(
          io, repo, clientManager, logger, redis, roomStateRepo,
          undefined, undefined, seatRepository, statusCoalescer, userRoomRepository,
        );

        // The room-broadcast copy — the one that carries the ejection.
        await router.route(
          createEvent({
            event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
            user_id: null,
            room_id: 7,
            timestamp: OLDER,
            payload: { room_id: 7, user_id: 42, remaining_seconds: 3600, permanent: false },
          }),
        );
        await flushPromises();
        await flushPromises();

        expectNoNonClaimSet(redis);
        expect(seatRepository.leaveSeat).not.toHaveBeenCalled();
        expect(userRoomRepository.clear).not.toHaveBeenCalled();
        expect(statusCoalescer.schedule).not.toHaveBeenCalled();
      });

      it("a fresh block DOES run the ejection on the room-broadcast copy", async () => {
        const redis = createGuardRedis(true);
        const seatRepository = { leaveSeat: vi.fn().mockResolvedValue({ success: false }) } as any;
        const roomStateRepo = { get: vi.fn().mockResolvedValue(null), save: vi.fn() } as any;
        const statusCoalescer = { schedule: vi.fn() } as any;
        const userRoomRepository = { get: vi.fn().mockResolvedValue(null), clear: vi.fn() } as any;

        const router = new EventRouter(
          io, repo, clientManager, logger, redis, roomStateRepo,
          undefined, undefined, seatRepository, statusCoalescer, userRoomRepository,
        );

        await router.route(
          createEvent({
            event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
            user_id: null,
            room_id: 7,
            timestamp: NEWER,
            payload: { room_id: 7, user_id: 42, remaining_seconds: 3600, permanent: false },
          }),
        );
        await flushPromises();
        await flushPromises();

        expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 3600);
        // Ejection reached the machinery — assert its first step, which runs
        // regardless of whether the user actually held a seat.
        expect(seatRepository.leaveSeat).toHaveBeenCalledWith("7", "42");
      });

      it("an unblock replayed after a newer block does NOT unlock the user", async () => {
        const redis = createGuardRedis(false);

        await new EventRouter(io, repo, clientManager, logger, redis).route(unblockEvent(OLDER));
        await flushPromises();

        expect(redis.del).not.toHaveBeenCalled();
        expect(metrics.laravelEventsStaleRejected.inc).toHaveBeenCalledWith({
          event_type: RELAY_EVENTS.room.ROOM_USER_UNBLOCKED,
        });
      });

      // Block and unblock must contend for ONE marker, or each would only ever
      // order itself against its own kind and reordering across the pair would
      // still land wrong.
      it("block and unblock version the same (room,user) marker", async () => {
        const redis = createGuardRedis(true);
        const router = new EventRouter(io, repo, clientManager, logger, redis);

        await router.route(blockEvent(OLDER));
        await flushPromises();
        await router.route(unblockEvent(NEWER));
        await flushPromises();

        const keys = redis.eval.mock.calls.map((call: unknown[]) => call[2]);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).toContain("7");
        expect(keys[0]).toContain("42");
      });

      it("still applies block and unblock when the guard accepts", async () => {
        const redis = createGuardRedis(true);
        const router = new EventRouter(io, repo, clientManager, logger, redis);

        await router.route(blockEvent(NEWER));
        await flushPromises();
        expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 3600);

        await router.route(unblockEvent(NEWER));
        await flushPromises();
        expect(redis.del).toHaveBeenCalledWith("room:7:blocked:42");
      });
    });

    describe("auth.revoke_tokens", () => {
      const revoke = (revokedAt: unknown) =>
        createEvent({
          event: RELAY_EVENTS.auth.REVOKE_TOKENS,
          user_id: 42,
          room_id: null,
          payload: { revoked_at: revokedAt },
        });

      it("writes the watermark through the newer-only guard", async () => {
        const redis = createGuardRedis(true);

        await new EventRouter(io, repo, clientManager, logger, redis).route(revoke(1_700_000_100));
        await flushPromises();

        expect(redis.eval).toHaveBeenCalled();
        const [, numKeys, key, value] = redis.eval.mock.calls[0]!;
        expect(numKeys).toBe(1);
        expect(key).toBe("auth:user_revoked:42");
        expect(value).toBe("1700000100");
        // The plain unconditional SET is gone — that was the replay hazard.
        expectNoNonClaimSet(redis);
      });

      it("a replayed revocation does not overwrite a newer one", async () => {
        const redis = createGuardRedis(false);

        await new EventRouter(io, repo, clientManager, logger, redis).route(revoke(1_700_000_000));
        await flushPromises();

        expect(metrics.laravelEventsStaleRejected.inc).toHaveBeenCalledWith({
          event_type: RELAY_EVENTS.auth.REVOKE_TOKENS,
        });
      });

      // Previously String(undefined) → "undefined" was stored as the watermark,
      // which jwtValidator can never match numerically: a revocation that
      // silently did nothing.
      it("refuses a non-numeric revoked_at instead of storing garbage", async () => {
        const redis = createGuardRedis(true);

        await new EventRouter(io, repo, clientManager, logger, redis).route(revoke(undefined));
        await flushPromises();

        expect(redis.eval).not.toHaveBeenCalled();
        expectNoNonClaimSet(redis);
        expect(logger.error).toHaveBeenCalled();
      });
    });

    // Every guard fails OPEN. Failing closed would silently stop applying
    // blocks, revocations and seat changes for the duration of a Redis blip —
    // a far larger incident than the reordering it defends against.
    it("applies the event anyway when the guard's Redis call fails", async () => {
      const redis = createGuardRedis(true);
      redis.eval.mockRejectedValue(new Error("redis down"));

      await new EventRouter(io, repo, clientManager, logger, redis).route(
        createEvent({
          event: RELAY_EVENTS.room.ROOM_MEMBER_REMOVED,
          user_id: 42,
          room_id: null,
          timestamp: NEWER,
          payload: { room_id: 7, user_id: 42, remaining_seconds: 3600, permanent: false },
        }),
      );
      await flushPromises();

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 3600);
    });
  });
});

// ─── aws-production 22: fleet-wide fan-out claim ─────────────────────────────
//
// Laravel fans the same envelope to every instance AND each adapter emit
// reaches the whole fleet — so exactly ONE instance may perform the emit per
// event. These tests simulate two instances as two EventRouters sharing one
// Redis (real SET NX semantics). If the claim gate is ever removed, the
// "second instance suppresses" test fails — that is the regression guard the
// ticket requires.
describe("fleet-wide fan-out claim (aws-production 22)", () => {
  // Minimal Redis honouring SET ... NX + DEL, shared across "instances".
  function createNxRedis() {
    const store = new Set<string>();
    return {
      set: vi.fn(
        async (key: string, _value: string, ...args: unknown[]) => {
          if (args.includes("NX")) {
            if (store.has(key)) return null;
            store.add(key);
            return "OK";
          }
          store.add(key);
          return "OK";
        },
      ),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
      _store: store,
    } as any;
  }

  function createInstance(redis: any) {
    const io = createMockIO();
    const repo = createMockRepo();
    return {
      io,
      repo,
      router: new EventRouter(io, repo, createMockClientManager(), createMockLogger(), redis),
    };
  }

  let redis: ReturnType<typeof createNxRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createNxRedis();
  });

  it("emits exactly once across two instances receiving the same room event", async () => {
    const a = createInstance(redis);
    const b = createInstance(redis);
    const event = createEvent({ room_id: 123, user_id: null });

    const first = await a.router.route(event);
    const second = await b.router.route(event);

    expect(a.io.to).toHaveBeenCalledWith("123");
    expect(b.io.to).not.toHaveBeenCalled();
    // Suppression is not a delivery failure — Laravel must not retry it.
    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(true);
    expect(metrics.laravelEventsFanoutSuppressed.inc).toHaveBeenCalledTimes(1);
    expect(metrics.laravelEventsFanoutSuppressed.inc).toHaveBeenCalledWith({
      event_type: "balance.updated",
    });
  });

  it("emits exactly once for broadcast events too", async () => {
    const a = createInstance(redis);
    const b = createInstance(redis);
    const event = createEvent({ room_id: null, user_id: null });

    await a.router.route(event);
    await b.router.route(event);

    expect(a.io.emit).toHaveBeenCalledTimes(1);
    expect(b.io.emit).not.toHaveBeenCalled();
  });

  it("still runs per-instance side effects on the suppressed instance", async () => {
    const a = createInstance(redis);
    const b = createInstance(redis);
    // force_disconnect: adapter emit is claimed, but disconnecting LOCAL
    // sockets must happen on every instance holding one.
    const socketB = { emit: vi.fn(), disconnect: vi.fn() };
    b.io.sockets.sockets = new Map([["sock-b", socketB]]);
    b.repo.getSocketIds.mockResolvedValue(["sock-b"]);
    a.repo.getSocketIds.mockResolvedValue([]);

    const event = createEvent({
      event: RELAY_EVENTS.auth.FORCE_DISCONNECT,
      user_id: 42,
      room_id: null,
      payload: { reason: "suspended" },
    });

    await a.router.route(event); // wins the claim
    await b.router.route(event); // suppressed emit — local disconnect still runs

    expect(socketB.disconnect).toHaveBeenCalledWith(true);
    expect(socketB.emit).toHaveBeenCalledWith(
      "auth:force_disconnect",
      expect.objectContaining({ reason: "suspended" }),
    );
  });

  it("fails open when the event has no correlation id", async () => {
    const a = createInstance(redis);
    const b = createInstance(redis);
    const event = createEvent({ room_id: 123, user_id: null, correlation_id: "unknown" });

    await a.router.route(event);
    await b.router.route(event);

    // No usable claim key — both emit (duplicates preferred over silence).
    expect(a.io.to).toHaveBeenCalledWith("123");
    expect(b.io.to).toHaveBeenCalledWith("123");
  });

  it("fails open when Redis errors on the claim", async () => {
    redis.set.mockRejectedValue(new Error("redis down"));
    const a = createInstance(redis);

    const result = await a.router.route(createEvent({ room_id: 123, user_id: null }));

    expect(a.io.to).toHaveBeenCalledWith("123");
    expect(result.delivered).toBe(true);
  });

  it("releases the claim when routing throws after winning it", async () => {
    const a = createInstance(redis);
    a.io.to.mockImplementation(() => {
      throw new Error("adapter exploded");
    });

    const result = await a.router.route(createEvent({ room_id: 123, user_id: null }));
    await flushPromises();

    expect(result.delivered).toBe(false);
    expect(redis.del).toHaveBeenCalledTimes(1);
    // The claim is free again — a redelivery can emit.
    expect(redis._store.size).toBe(0);
  });
});
