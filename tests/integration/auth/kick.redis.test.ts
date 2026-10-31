/**
 * account-bans 18 — fleet-wide force kick and re-check kick, across TWO real
 * Socket.IO servers on a shared REAL Redis.
 *
 * Why this exists: the old `forceDisconnectUser` only touched sockets local to the
 * instance that consumed the event, so with two instances it missed about half the
 * time. The mock-IO unit tests in tests/unit/integrations/laravel/event-router.test.ts
 * cannot see that miss (a mock `io` has no second node) — this file is the seam that can.
 *
 * Topology (all in this process, on ephemeral ports):
 *
 *   socket.io-client ──► server B (holds the socket)         ┐ @socket.io/redis-adapter,
 *   EventRouter.route() ► server A (ingests the event)       ┘ wired as server.ts wires it
 *                         both on one real Redis
 *
 * The socket lives on B only; the event is ingested on A only. The kick can reach the
 * client only through the adapter, which is exactly what the production fix relies on.
 *
 * What is real: both Socket.IO servers, the redis-adapter, the socket.io-client, the
 * EventRouter, and the Redis-backed UserSocketRepository / SeatRepository /
 * UserRoomRepository / RoomStateRepository. What is stubbed: the connection bootstrap on
 * B (no JWT stack — a handshake `userId` is trusted), the StatusCoalescer (Laravel HTTP),
 * and finalizeLeave's seat step — B's disconnect handler calls `reserveSeat` directly,
 * the same call src/domains/room/leave-finalizer.ts makes on a socket death.
 *
 * Address: MSAB_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379/15), else REDIS_HOST/REDIS_PORT
 * with db 15 — same as ledger.redis.test.ts. With no Redis: SKIPPED LOUDLY locally, but
 * FAILS when CI is set (a silently-skipped kick test would let the cross-server miss ship).
 *
 * Isolation: every test uses unique user/room ids and deletes only the keys it created
 * (never FLUSHDB). The adapter uses a unique channel `key` per run — Redis pub/sub is NOT
 * scoped to a db, so without it a dev MSAB on the same Redis would join these two nodes
 * as a third. That is the one deliberate difference from production's default key.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi, type TestContext } from "vitest";
import { Redis } from "ioredis";
import { pino } from "pino";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { EventRouter } from "@src/integrations/laravel/event-router.js";
import { UserSocketRepository } from "@src/integrations/laravel/user-socket.repository.js";
import { UserRoomRepository } from "@src/integrations/laravel/user-room.repository.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";
import { SeatRepository } from "@src/domains/seat/seat.repository.js";
import { RoomStateRepository } from "@src/domains/room/roomState.js";
import type { StatusCoalescer } from "@src/domains/room/status-coalescer.js";
import { ClientManager } from "@src/client/clientManager.js";
import { buildFanoutClaimKey } from "@src/infrastructure/event-dedup.js";

const url =
  process.env.MSAB_TEST_REDIS_URL ??
  `redis://${process.env.REDIS_HOST ?? "127.0.0.1"}:${process.env.REDIS_PORT ?? "6379"}/15`;

/** GitHub Actions sets CI=true; treat an explicit "false"/"0" as unset. */
const inCI = Boolean(process.env.CI) && process.env.CI !== "false" && process.env.CI !== "0";

const SEAT_COUNT = 8;
const WAIT_MS = 3_000;

// The wire literals Laravel sends. Written out on purpose (not RELAY_EVENTS.*) so this
// test also pins the strings — Laravel ticket 17 sends the same re-check literal.
const FORCE_DISCONNECT = "auth.force_disconnect";
const RECHECK_DISCONNECT = "auth.recheck_disconnect";

const logger = pino({ level: "silent" });

// ─── Gating ───────────────────────────────────────────────────────────────────

let available = false;

async function probeRedis(): Promise<boolean> {
  const probe = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

/** Skip loudly locally; FAIL in CI. Call first in every test. */
function requireRedis(skip: TestContext["skip"]): void {
  if (available) return;
  if (inCI) {
    throw new Error(
      `kick.redis.test.ts: no Redis answered at ${url} and CI is set. CI must provide a Redis ` +
        `(services: redis:7-alpine + MSAB_TEST_REDIS_URL) — a skipped kick test lets the ` +
        `cross-server miss ship.`,
    );
  }
  skip();
}

// ─── Small helpers ────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Reject after `ms` so a missed kick fails fast with a clear message (not a vitest timeout). */
async function within<T>(promise: Promise<T>, what: string, ms: number = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deleteByPattern(redis: Redis, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

// ─── Two nodes ────────────────────────────────────────────────────────────────

interface Node {
  io: Server;
  http: HttpServer;
  port: number;
  pub: Redis;
  sub: Redis;
}

/** Wired the way src/infrastructure/server.ts wires it: pub + pub.duplicate(), requestsTimeout 2s. */
async function startNode(adapterKey: string): Promise<Node> {
  const http = createServer();
  const pub = new Redis(url);
  const sub = pub.duplicate();
  const io = new Server(http, {
    adapter: createAdapter(pub, sub, { key: adapterKey, requestsTimeout: 2_000 }),
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { io, http, port: (http.address() as AddressInfo).port, pub, sub };
}

async function stopNode(node: Node): Promise<void> {
  await node.io.close();
  await Promise.allSettled([node.pub.quit(), node.sub.quit()]);
}

/** Per-user hooks the minimal connection path on B resolves. */
interface BHooks {
  /** B finished registering the socket in the Redis per-user set. */
  registered: Deferred<void>;
  /** B's disconnect handler finished; value = seat indices it reserved (finalizeLeave's step). */
  disconnected: Deferred<number[]>;
}

let nodeA: Node;
let nodeB: Node;
let redisA: Redis; // data client of server A (router + repos)
let redisB: Redis; // data client of server B (its connection path)
let router: EventRouter; // lives on A
let seatsA: SeatRepository;
let userRoomsA: UserRoomRepository;
let userSocketsA: UserSocketRepository;
const bHooks = new Map<number, BHooks>();

beforeAll(async () => {
  available = await probeRedis();
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠️  kick.redis.test.ts ${inCI ? "FAILING (CI is set)" : "SKIPPED"} — no Redis at ${url}. ` +
        `Set MSAB_TEST_REDIS_URL to run the fleet-wide kick suite.\n`,
    );
    return;
  }

  const adapterKey = `msab-test-kick-${randomUUID()}`;
  [nodeA, nodeB] = await Promise.all([startNode(adapterKey), startNode(adapterKey)]);
  redisA = new Redis(url);
  redisB = new Redis(url);

  // ── Server B: minimal auth + connection path (no JWT stack) ────────────────
  const seatsB = new SeatRepository(redisB);
  const userSocketsB = new UserSocketRepository(redisB, logger);
  nodeB.io.use((socket, next) => {
    const userId = Number(socket.handshake.auth["userId"]);
    if (!Number.isInteger(userId)) return next(new Error("userId required"));
    socket.data["user"] = { id: userId };
    next();
  });
  nodeB.io.on("connection", (socket) => {
    const userId = (socket.data["user"] as { id: number }).id;
    const roomId = String(socket.handshake.auth["roomId"]);
    const hooks = bHooks.get(userId);

    socket.on("disconnect", () => {
      void (async () => {
        // What finalizeLeave does on a socket death: reserve a seated user's slot for the
        // grace window (no-op, returns [], when the seat is already gone), then drop the
        // per-user socket registration.
        const reserved = await seatsB.reserveSeat(roomId, String(userId), Date.now());
        await userSocketsB.unregisterSocket(userId, socket.id);
        hooks?.disconnected.resolve(reserved);
      })();
    });

    void (async () => {
      await socket.join(roomId);
      await userSocketsB.registerSocket(userId, socket.id);
      hooks?.registered.resolve();
    })();
  });

  // ── Server A: the instance that ingests the Laravel event ──────────────────
  seatsA = new SeatRepository(redisA);
  userRoomsA = new UserRoomRepository(redisA, logger);
  userSocketsA = new UserSocketRepository(redisA, logger);
  const statusCoalescer = { submit: vi.fn() } as unknown as StatusCoalescer;
  router = new EventRouter(
    nodeA.io,
    userSocketsA,
    new ClientManager(),
    logger,
    redisA,
    new RoomStateRepository(redisA),
    undefined, // forceCloseLocalRoom
    undefined, // roomManager
    seatsA,
    statusCoalescer,
    userRoomsA,
  );
});

afterAll(async () => {
  if (!available) return;
  await Promise.allSettled([stopNode(nodeA), stopNode(nodeB)]);
  await Promise.allSettled([redisA.quit(), redisB.quit()]);
});

// ─── Per-test scenario ────────────────────────────────────────────────────────

let idCounter = 0;
const created: { userId: number; roomId: string; client: ClientSocket; claimKey: string | null }[] = [];

interface Scenario {
  userId: number;
  roomId: string;
  /** Every event the client received, in order: [name, payload]. */
  received: [string, unknown][];
  /** Resolves with the client's `disconnect` reason. */
  clientDisconnected: Promise<string>;
  /** B's disconnect handler finished; resolves with the seat indices it reserved. */
  serverDisconnected: Promise<number[]>;
}

/**
 * A user seated at seat 0 of a fresh room, with its one socket on server B only
 * (server A holds none) — the seat in Redis, user→room mapped, socket registered.
 */
async function seatedUserOnB(): Promise<Scenario> {
  const userId = 9_100_000 + (Date.now() % 1_000_000) * 100 + ++idCounter;
  const roomId = `kick-test-${randomUUID()}`;

  const seat = await seatsA.takeSeat(roomId, String(userId), 0, SEAT_COUNT);
  expect(seat.success).toBe(true);
  await userRoomsA.setUserRoom(userId, roomId);

  const hooks: BHooks = { registered: deferred<void>(), disconnected: deferred<number[]>() };
  bHooks.set(userId, hooks);

  const client = connectClient(`http://127.0.0.1:${nodeB.port}`, {
    reconnection: false,
    transports: ["websocket"],
    auth: { userId, roomId },
  });
  created.push({ userId, roomId, client, claimKey: null });

  const received: [string, unknown][] = [];
  client.onAny((name: string, payload: unknown) => received.push([name, payload]));
  const clientDisconnected = new Promise<string>((resolve) => client.on("disconnect", resolve));

  await within(new Promise<void>((resolve) => client.on("connect", resolve)), "client connect to server B");
  // `connect` fires before B's async registration; ingesting earlier would find no sockets.
  await within(hooks.registered.promise, "server B to register the socket");

  // The premise of the whole test: the socket is on B and NOT on A.
  expect(nodeB.io.sockets.sockets.size).toBeGreaterThanOrEqual(1);
  expect(nodeA.io.sockets.sockets.size).toBe(0);
  expect(await userSocketsA.getSocketIds(userId)).toEqual([client.id]);

  return { userId, roomId, received, clientDisconnected, serverDisconnected: hooks.disconnected.promise };
}

function kickEvent(name: string, userId: number, payload: Record<string, unknown>): LaravelEvent {
  // A fresh correlation id per event: route() takes a fleet-wide SET NX claim keyed on the
  // envelope, and a repeat within its 600 s TTL would suppress the kick.
  return { event: name, user_id: userId, room_id: null, payload, correlation_id: randomUUID() };
}

async function ingestOnA(scenario: Scenario, event: LaravelEvent) {
  const entry = created.find((c) => c.userId === scenario.userId);
  if (entry) entry.claimKey = buildFanoutClaimKey(event);
  return router.route(event);
}

afterEach(async () => {
  if (!available) return;
  for (const { userId, roomId, client, claimKey } of created) {
    client.close();
    // Let B's disconnect handler finish before the keys are removed / Redis clients go away.
    const hooks = bHooks.get(userId);
    if (hooks) await within(hooks.disconnected.promise, "server B disconnect handler", 2_000).catch(() => undefined);
    await deleteByPattern(redisA, `room:${roomId}:*`);
    await deleteByPattern(redisA, `user:${userId}:*`);
    if (claimKey) await redisA.del(claimKey);
    bHooks.delete(userId);
  }
  created.length = 0;
});

// ─── The tests ────────────────────────────────────────────────────────────────

describe("kicks reach a socket held by ANOTHER server (real Redis adapter)", () => {
  it("force: client on B gets auth:force_disconnect (payload unchanged), is disconnected, seat freed with no grace", async ({
    skip,
  }) => {
    requireRedis(skip);
    const s = await seatedUserOnB();
    const payload = { reason: "blocked", blocked_until: null, blocked_reason: "x" };

    await ingestOnA(s, kickEvent(FORCE_DISCONNECT, s.userId, payload));

    // Freed IMMEDIATELY — checked before waiting on the client, so a grace/reservation
    // (which the disconnect path would create) can't be what we are observing.
    expect(await seatsA.getUserSeat(s.roomId, String(s.userId))).toBeNull();
    expect(await seatsA.getSeatOccupant(s.roomId, 0)).toBeNull();
    // user→room is cleared by the holding instance's own disconnect path (finalizeLeave),
    // which this test's minimal server B does not run; the kick only frees the seat.

    // The client sits on B; the kick had to cross the adapter to reach it.
    const reason = await within(s.clientDisconnected, "client on B to be disconnected");
    expect(reason).toBe("io server disconnect");

    // Exactly one colon-form emit, payload byte-for-byte as Laravel sent it. (The router's
    // "user" pass-through also relays the dotted `auth.force_disconnect`; that is
    // pre-existing and not asserted on.)
    expect(s.received.filter(([name]) => name === "auth:force_disconnect")).toEqual([
      ["auth:force_disconnect", payload],
    ]);

    // B's own disconnect path ran after the kick: it must find nothing to reserve, and
    // the seat must still be free once it is done.
    expect(await within(s.serverDisconnected, "server B disconnect handler")).toEqual([]);
    expect(await seatsA.getUserSeat(s.roomId, String(s.userId))).toBeNull();
    expect(await seatsA.getSeatOccupant(s.roomId, 0)).toBeNull();
  });

  it("re-check: client on B is disconnected with NO emit, and the seat is left for the normal grace", async ({
    skip,
  }) => {
    requireRedis(skip);
    const s = await seatedUserOnB();

    await ingestOnA(s, kickEvent(RECHECK_DISCONNECT, s.userId, {}));

    // The kick itself clears nothing: seat and user→room are untouched right after it.
    expect(await seatsA.getUserSeat(s.roomId, String(s.userId))).toBe(0);
    expect(await seatsA.getSeatOccupant(s.roomId, 0)).toBe(String(s.userId));
    expect(await userRoomsA.getUserRoom(s.userId)).toBe(s.roomId);

    const reason = await within(s.clientDisconnected, "client on B to be disconnected");
    expect(reason).toBe("io server disconnect");

    // Neither the colon-form emit nor the raw relay name reached the client — nothing at
    // all did, so an innocent neighbour never sees the "account suspended" screen.
    expect(s.received).toEqual([]);

    // The ordinary disconnect path then HOLDS the seat (reserve, not release): the seat is
    // still occupied by the user, marked reserved — that marker is what the 120 s grace
    // and the reconnect re-claim run on.
    expect(await within(s.serverDisconnected, "server B disconnect handler")).toEqual([0]);
    const seats = await seatsA.getSeats(s.roomId, SEAT_COUNT);
    expect(seats[0]).toMatchObject({ index: 0, userId: String(s.userId), reserved: true });
  });
});
