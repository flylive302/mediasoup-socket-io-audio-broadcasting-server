import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: { LARAVEL_INTERNAL_KEY: "test-internal-key", INSTANCE_ID: "i-test-box-1" },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { createEventIngestRoutes } from "@src/infrastructure/event-ingest.js";

const MAX_CONCURRENT_EVENTS = 100;

function makeEvent(n: number) {
  return {
    event: `e-${n}`,
    user_id: null,
    room_id: null,
    payload: {},
    timestamp: new Date().toISOString(),
    correlation_id: `c-${n}`,
  };
}

describe("event-ingest backpressure (F-40)", () => {
  let app: FastifyInstance;
  let release: () => void;
  let routeCalls: number;

  beforeEach(async () => {
    routeCalls = 0;
    // route() hangs until release() so we can pin N requests in-flight.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventRouter = {
      route: vi.fn(async () => {
        routeCalls++;
        await gate;
        return { delivered: true, targetCount: 1 };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    app = Fastify({ logger: false });
    await app.register(createEventIngestRoutes(eventRouter));
    await app.ready();
  });

  it("sheds with 503 once MAX_CONCURRENT_EVENTS are in flight", async () => {
    const inject = (n: number) =>
      app.inject({
        method: "POST",
        url: "/api/events",
        headers: { "x-internal-key": "test-internal-key" },
        payload: makeEvent(n),
      });

    // Saturate: 100 requests that block inside route().
    const pending = Array.from({ length: MAX_CONCURRENT_EVENTS }, (_, i) =>
      inject(i),
    );
    // Let the 100 reach (and block in) route().
    await vi.waitFor(() => expect(routeCalls).toBe(MAX_CONCURRENT_EVENTS));

    // The next one must be shed without entering route().
    const shed = await inject(999);
    expect(shed.statusCode).toBe(503);
    expect(shed.headers["retry-after"]).toBe("1");
    expect(routeCalls).toBe(MAX_CONCURRENT_EVENTS); // 999 never routed

    // Drain the held requests.
    release();
    const results = await Promise.all(pending);
    for (const r of results) expect(r.statusCode).toBe(200);

    // Capacity recovered.
    const after = await inject(1000);
    expect(after.statusCode).toBe(200);
  });

  it("rejects unauthorized requests with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "x-internal-key": "wrong" },
      payload: makeEvent(1),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("event-ingest SNS delivery formats", () => {
  let app: FastifyInstance;
  let routedEvents: unknown[];

  beforeEach(async () => {
    routedEvents = [];
    const eventRouter = {
      route: vi.fn(async (event: unknown) => {
        routedEvents.push(event);
        return { delivered: true, targetCount: 1 };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    app = Fastify({ logger: false });
    await app.register(createEventIngestRoutes(eventRouter));
    await app.ready();
  });

  it("routes a direct/raw-delivery event (no SNS envelope)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "x-internal-key": "test-internal-key" },
      payload: makeEvent(1),
    });

    expect(res.statusCode).toBe(200);
    expect(routedEvents).toHaveLength(1);
    expect((routedEvents[0] as { event: string }).event).toBe("e-1");
  });

  it("unwraps an SNS Notification envelope (Raw Message Delivery OFF)", async () => {
    // SNS cannot send custom headers, so the internal key arrives as ?key=.
    const envelope = {
      Type: "Notification",
      MessageId: "m-1",
      TopicArn: "arn:aws:sns:ap-south-1:000:flylive",
      Message: JSON.stringify(makeEvent(2)),
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/events?key=test-internal-key",
      headers: {
        "content-type": "text/plain",
        "x-amz-sns-message-type": "Notification",
      },
      payload: JSON.stringify(envelope),
    });

    expect(res.statusCode).toBe(200);
    expect(routedEvents).toHaveLength(1);
    expect((routedEvents[0] as { event: string }).event).toBe("e-2");
  });

  it("422s an SNS Notification whose Message is not a valid event", async () => {
    const envelope = {
      Type: "Notification",
      Message: JSON.stringify({ not: "an-event" }),
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/events?key=test-internal-key",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(envelope),
    });

    expect(res.statusCode).toBe(422);
    expect(routedEvents).toHaveLength(0);
  });
});

describe("event-ingest SNS SubscriptionConfirmation is deleted (platform-security/02)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventRouter = { route: vi.fn() } as any;
    app = Fastify({ logger: false });
    await app.register(createEventIngestRoutes(eventRouter));
    await app.ready();
  });

  it("triggers no outbound fetch and is rejected exactly like an unauthenticated request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: makeEvent(1),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/events",
        headers: { "x-amz-sns-message-type": "SubscriptionConfirmation" },
        payload: { SubscribeURL: "http://attacker.example/confirm" },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.statusCode).toBe(unauthenticated.statusCode);
      expect(res.json()).toEqual(unauthenticated.json());
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * aws-platform-build/07 — at-least-once dedup at the ingest boundary.
 *
 * The store is a real Redis SET NX in production; here it is an in-memory Map
 * with the same contract, so the tests exercise the route's decisions rather
 * than ioredis. `set(...,"NX")` resolves "OK" on first write and null after.
 */
function createFakeDedupRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  } as any;
}

describe("event-ingest deduplication (aws-platform-build/07)", () => {
  const AUTH = { "x-internal-key": "test-internal-key" };

  let app: FastifyInstance;
  let redis: ReturnType<typeof createFakeDedupRedis>;
  let route: ReturnType<typeof vi.fn>;

  /** One logical envelope; every field stable so a resend is a true redelivery. */
  const envelope = {
    event: "room.updated",
    user_id: null,
    room_id: 42,
    payload: { room: { max_seats: 8 } },
    timestamp: "2026-08-06T00:00:00+00:00",
    correlation_id: "corr-abc-123",
  };

  const post = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/events", headers: AUTH, payload: payload as object });

  beforeEach(async () => {
    vi.clearAllMocks();
    redis = createFakeDedupRedis();
    route = vi.fn().mockResolvedValue({ delivered: true, targetCount: 1 });
    app = Fastify({ logger: false });
    await app.register(createEventIngestRoutes({ route } as any, redis));
    await app.ready();
  });

  it("routes the first delivery and suppresses an identical redelivery", async () => {
    const first = await post(envelope);
    const second = await post(envelope);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "ok", delivered: true });

    // 200, not 4xx: a non-2xx would make Laravel retry the very delivery we suppressed.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "ok", duplicate: true, delivered: false });

    expect(route).toHaveBeenCalledTimes(1);
  });

  it("keeps suppressing across many redeliveries, not just the second", async () => {
    for (let i = 0; i < 5; i++) await post(envelope);
    expect(route).toHaveBeenCalledTimes(1);
  });

  /**
   * THE REGRESSION THIS GATE COULD CAUSE.
   *
   * Laravel's kick path emits `room.member_removed` twice inside ONE request
   * (RoomEventEmitter.php:116-117), so both copies carry the SAME
   * correlation_id and the same payload — only user_id/room_id differ. MSAB
   * gates seat ejection on the room-broadcast copy. Deduplicating on bare
   * correlation_id would drop it and leave blocked users in their seats.
   */
  it("does NOT collapse the kick path's two same-correlation_id copies", async () => {
    const shared = {
      event: "room.member_removed",
      payload: { room_id: 42, user_id: 7, permanent: true },
      timestamp: "2026-08-06T00:00:00+00:00",
      correlation_id: "corr-same-request",
    };

    const userCopy = await post({ ...shared, user_id: 7, room_id: null });
    const roomCopy = await post({ ...shared, user_id: null, room_id: 42 });

    expect(userCopy.json()).not.toMatchObject({ duplicate: true });
    expect(roomCopy.json()).not.toMatchObject({ duplicate: true });
    expect(route).toHaveBeenCalledTimes(2);
  });

  it("does not collapse distinct events that share one request's correlation_id", async () => {
    const base = { user_id: 7, room_id: null, payload: {}, correlation_id: "corr-one-request" };
    await post({ ...base, event: "balance.updated" });
    await post({ ...base, event: "badge.earned" });

    expect(route).toHaveBeenCalledTimes(2);
  });

  it("never dedups events whose correlation_id is the absent-value default", async () => {
    // All of these would otherwise share one key and collapse to a single delivery.
    for (let i = 0; i < 3; i++) {
      const res = await post({ ...envelope, correlation_id: "unknown" });
      expect(res.json()).not.toMatchObject({ duplicate: true });
    }
    expect(route).toHaveBeenCalledTimes(3);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("ignores timestamp when matching, so a resend with a fresh clock still dedups", async () => {
    await post(envelope);
    const resend = await post({ ...envelope, timestamp: "2026-08-06T09:99:99+00:00" });

    expect(resend.json()).toMatchObject({ duplicate: true });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("treats a differing payload as a different event", async () => {
    await post(envelope);
    const changed = await post({ ...envelope, payload: { room: { max_seats: 4 } } });

    expect(changed.json()).not.toMatchObject({ duplicate: true });
    expect(route).toHaveBeenCalledTimes(2);
  });

  /**
   * Ordering guard: the dedup claim must sit AFTER the 503 shed. Claiming first
   * would mark a shed event as seen and then drop Laravel's retry of it —
   * silent event loss exactly when load is highest.
   */
  it("does not consume a claim for an event it sheds, so the retry still lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocking = vi.fn(async () => { await gate; return { delivered: true, targetCount: 1 }; });

    const shedApp = Fastify({ logger: false });
    const shedRedis = createFakeDedupRedis();
    await shedApp.register(createEventIngestRoutes({ route: blocking } as any, shedRedis));
    await shedApp.ready();

    const inFlight = Array.from({ length: MAX_CONCURRENT_EVENTS }, (_, i) =>
      shedApp.inject({
        method: "POST", url: "/api/events", headers: AUTH,
        payload: { ...envelope, correlation_id: `filler-${i}` },
      }),
    );
    await vi.waitFor(() => expect(blocking).toHaveBeenCalledTimes(MAX_CONCURRENT_EVENTS));

    const shed = await shedApp.inject({
      method: "POST", url: "/api/events", headers: AUTH, payload: envelope,
    });
    expect(shed.statusCode).toBe(503);

    release();
    await Promise.all(inFlight);

    // The retry of the shed event must be routed, NOT suppressed as a duplicate.
    const retry = await shedApp.inject({
      method: "POST", url: "/api/events", headers: AUTH, payload: envelope,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).not.toMatchObject({ duplicate: true });
    expect(blocking).toHaveBeenCalledTimes(MAX_CONCURRENT_EVENTS + 1);
  });

  it("releases the claim when routing throws, so the retry is allowed through", async () => {
    route.mockRejectedValueOnce(new Error("router blew up"));

    await post(envelope).catch(() => undefined);
    expect(redis.del).toHaveBeenCalledTimes(1);

    const retry = await post(envelope);
    expect(retry.json()).not.toMatchObject({ duplicate: true });
  });

  it("keeps the claim when routing merely reports non-delivery (a terminal outcome)", async () => {
    route.mockResolvedValue({ delivered: false, targetCount: 0 });

    const first = await post(envelope);
    expect(first.json()).toMatchObject({ delivered: false });
    expect(redis.del).not.toHaveBeenCalled();

    const retry = await post(envelope);
    expect(retry.json()).toMatchObject({ duplicate: true });
    expect(route).toHaveBeenCalledTimes(1);
  });

  /**
   * MSAB's Redis is shared fleet-wide (the socket.io adapter is built on the
   * same client), while Laravel deliberately POSTs the IDENTICAL envelope to
   * every endpoint in MSAB_EVENT_URLS so each instance can serve its own local
   * sockets. A fleet-wide key would let whichever instance arrives first
   * suppress the event for all the others. Dormant on today's one box; live
   * again the moment a second box returns.
   */
  it("scopes the claim to this instance, so a sibling box is not suppressed", async () => {
    await post(envelope);

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0]![0]).toContain("i-test-box-1");
  });

  it("fails open — a Redis outage lets every event through rather than dropping it", async () => {
    redis.set.mockRejectedValue(new Error("redis down"));

    await post(envelope);
    await post(envelope);

    expect(route).toHaveBeenCalledTimes(2);
  });

  it("is inert when no store is supplied (ingest behaves exactly as before)", async () => {
    const bare = Fastify({ logger: false });
    const bareRoute = vi.fn().mockResolvedValue({ delivered: true, targetCount: 1 });
    await bare.register(createEventIngestRoutes({ route: bareRoute } as any));
    await bare.ready();

    for (let i = 0; i < 3; i++) {
      await bare.inject({ method: "POST", url: "/api/events", headers: AUTH, payload: envelope });
    }
    expect(bareRoute).toHaveBeenCalledTimes(3);
  });
});
