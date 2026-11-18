/**
 * gift-cashback-latency 08: a lucky result is shown to the client exactly once
 * even though Laravel now delivers it twice — inline in the gift batch response
 * (GiftBuffer) and again through the outbox (EventRouter). Whichever path
 * reaches MSAB first wins; the other drops its copy.
 *
 * These tests drive BOTH real paths (GiftBuffer.stop() for the inline copy,
 * EventRouter.route() for the queued copy) against ONE Map-backed Redis whose
 * `SET … NX` is faithful, so they fail if the two paths ever build different
 * claim keys. luckyShownClaim.ts itself is deliberately not mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";

vi.mock("@src/config/index.js", () => ({
  config: {
    // EventRouter
    JWT_MAX_AGE_SECONDS: 2592000,
    CASCADE_ENABLED: false,
    INTERNAL_API_KEY: "",
    PUBLIC_IP: "",
    PORT: 3030,
    LOG_LEVEL: "silent",
    MAX_SEAT_COUNT: 30,
    // GiftBuffer
    GIFT_BUFFER_FLUSH_INTERVAL_MS: 5000,
    GIFT_MAX_RETRIES: 5,
    GIFT_FALLBACK_BUDGET_MS: 5_000,
    INSTANCE_ID: "i-test",
  },
  isDev: false,
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockReconcileBalance = vi.fn().mockResolvedValue(null);
vi.mock("@src/domains/gift/balanceSync.js", () => ({
  reconcileBalance: (...a: unknown[]) => mockReconcileBalance(...a),
  forceRefresh: vi.fn().mockResolvedValue(true),
  balanceAuthorityEnforcing: () => false,
  rewriteBalancePush: (payload: Record<string, unknown>) => payload,
}));

// Ticker off: the room leg is a direct emit to the room.
vi.mock("@src/domains/gift/flags.js", () => ({
  giftPendingTtlMs: () => 30_000,
  giftFlushPartitions: () => 1,
  giftRoomTickMs: () => 0,
}));

vi.mock("@src/domains/gift/roomTicker.js", () => ({ enqueueLucky: vi.fn() }));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    // GiftBuffer
    giftBatchSize: { observe: vi.fn() },
    giftsProcessed: { inc: vi.fn() },
    giftShownUnpaidTotal: { inc: vi.fn() },
    giftDeadLetterSize: { set: vi.fn() },
    giftQueueDepth: { set: vi.fn() },
    giftBufferWaitSeconds: { observe: vi.fn() },
    giftBatchPostSeconds: { observe: vi.fn() },
    redisDegradations: { inc: vi.fn() },
    giftInflightReclaimed: { inc: vi.fn() },
    giftDeadLetterReplayed: { inc: vi.fn() },
    giftDeadLetterExpired: { inc: vi.fn() },
    giftDeadLetterHighWater: { inc: vi.fn() },
    giftDeadLetterTrimmed: { inc: vi.fn() },
    giftLuckyInlineTotal: { inc: vi.fn() },
    giftLuckyResultLatencySeconds: { observe: vi.fn() },
    giftLuckyDuplicateDroppedTotal: { inc: vi.fn() },
    // EventRouter
    laravelEventsReceived: { inc: vi.fn() },
    laravelEventsInFlight: { inc: vi.fn(), dec: vi.fn() },
    laravelEventProcessingDuration: { observe: vi.fn() },
    laravelEventsDeduplicated: { inc: vi.fn() },
    laravelEventsStaleRejected: { inc: vi.fn() },
    laravelEventsFanoutSuppressed: { inc: vi.fn() },
    roomBlockMirror: { inc: vi.fn() },
  },
}));

import { GiftBuffer } from "@src/domains/gift/giftBuffer.js";
import { EventRouter } from "@src/integrations/laravel/event-router.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { logger } from "@src/infrastructure/logger.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";

// ─── Harness ────────────────────────────────────────────────────────

/** Shared backend<->room-server contract fixture (byte-identical in both repos). */
const contract = JSON.parse(
  readFileSync(resolve(__dirname, "../../../fixtures/contracts/gift-balance-contract.json"), "utf8"),
);

const NOW = 1_700_000_010_000;
const REF = "tx-ref-1";
const SENDER_ID = 1;
const ROOM_ID = 42;

/** What the client would receive, with its target(s) — one entry per emit. */
interface Emit {
  to: string[];
  event: string;
  payload: unknown;
}

function createIo() {
  const emits: Emit[] = [];
  const chain = (to: string[]) => ({
    to: (id: string) => chain([...to, id]),
    emit: (event: string, payload: unknown) => {
      emits.push({ to, event, payload });
    },
  });
  return {
    to: (id: string) => chain([id]),
    emit: vi.fn(),
    sockets: { adapter: { rooms: new Map<string, Set<string>>() } },
    emits,
  };
}

/**
 * ONE Redis shared by both paths (MSAB's Redis is fleet-wide). `set` is
 * NX-faithful: "OK" when the key was absent, null when it already existed.
 * `eval` serves the gift buffer's claim script (see giftBuffer.test.ts).
 */
function createSharedRedis() {
  const store = new Map<string, string>();
  const redis = {
    store,
    _claimItems: [] as string[],
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (_lua: string, numKeys: number, k1: string) => {
      if (numKeys === 2 && k1 === "gifts:pending") return redis._claimItems;
      if (numKeys === 2 || numKeys === 1) return numKeys === 1 ? [] : 0;
      return [];
    }),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    rpush: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue("OK"),
    llen: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn(() => {
      const p = {
        rpush: vi.fn().mockReturnThis(),
        ltrim: vi.fn().mockReturnThis(),
        lrem: vi.fn().mockReturnThis(),
        del: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      return p;
    }),
  };
  return redis;
}

const senderPayload = (extra: Record<string, unknown> = {}) => ({
  multiplier: 2,
  coins_won: 100,
  reference_id: REF,
  tapped_at: NOW - 1500,
  ...extra,
});

const roomPayload = (extra: Record<string, unknown> = {}) => ({
  sender_id: SENDER_ID,
  gift_id: 100,
  coins_won: 100,
  room_id: ROOM_ID,
  reference_id: REF,
  tapped_at: NOW - 1500,
  ...extra,
});

function laravelEvent(overrides: Partial<LaravelEvent>): LaravelEvent {
  return {
    event: "lucky:result",
    user_id: null,
    room_id: null,
    payload: {},
    timestamp: new Date(NOW).toISOString(),
    correlation_id: "corr-1",
    ...overrides,
  };
}

describe("lucky shown-once claim across the inline and queued paths", () => {
  let io: ReturnType<typeof createIo>;
  let redis: ReturnType<typeof createSharedRedis>;
  let socketsBySender: Record<number, string[]>;
  let userSocketRepo: { getSocketIds: ReturnType<typeof vi.fn> };
  let buffer: GiftBuffer;
  let router: EventRouter;

  const emitted = (event: string) => io.emits.filter((e) => e.event === event);

  /** The inline copy: a gift batch whose Laravel response carries `lucky[]`. */
  async function inlineCopy(entry: {
    kind: "result" | "no-draw";
    sender: Record<string, unknown>;
    room: Record<string, unknown> | null;
  }): Promise<void> {
    redis._claimItems = [
      JSON.stringify({
        transaction_id: REF,
        room_id: String(ROOM_ID),
        sender_id: SENDER_ID,
        recipient_ids: [2],
        gift_id: 100,
        quantity: 1,
        timestamp: NOW,
        sender_socket_id: "sock-1",
      }),
    ];
    laravel.processGiftBatch.mockResolvedValue({
      failed: [],
      lucky_inline: true,
      lucky: [{ transaction_ids: [REF], sender_id: SENDER_ID, room_id: ROOM_ID, ...entry }],
    });
    await buffer.stop();
    await vi.advanceTimersByTimeAsync(0);
  }

  /** The queued copy: the outbox relay envelope routed by EventRouter. */
  async function queuedSenderCopy(event: "lucky:result" | "lucky:no-draw", payload: unknown) {
    return router.route(laravelEvent({ event, user_id: SENDER_ID, payload: payload as never }));
  }

  async function queuedRoomCopy(payload: unknown) {
    return router.route(
      laravelEvent({ event: "lucky:room-result", room_id: ROOM_ID, payload: payload as never }),
    );
  }

  const laravel = { processGiftBatch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    io = createIo();
    redis = createSharedRedis();
    socketsBySender = { [SENDER_ID]: ["sock-1"] };
    userSocketRepo = {
      getSocketIds: vi.fn(async (userId: number) => socketsBySender[userId] ?? []),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    buffer = new GiftBuffer(redis as unknown as Redis, laravel as never, io as never, log, userSocketRepo as never);
    router = new EventRouter(
      io as never,
      userSocketRepo as never,
      {
        updateUserProfile: vi.fn().mockReturnValue(new Set()),
        getClient: vi.fn(),
        addClient: vi.fn(),
        removeClient: vi.fn(),
      } as never,
      log,
      redis as unknown as Redis,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Seam 6: exactly one, whichever path arrives first ────────────

  it("inline copy first, then the queued copy: one lucky:result to the sender and one lucky:room-result to the room", async () => {
    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });
    const senderRouted = await queuedSenderCopy("lucky:result", senderPayload());
    const roomRouted = await queuedRoomCopy(roomPayload());

    expect(emitted("lucky:result")).toStrictEqual([
      { to: ["sock-1"], event: "lucky:result", payload: senderPayload() },
    ]);
    expect(emitted("lucky:room-result")).toStrictEqual([
      { to: [String(ROOM_ID)], event: "lucky:room-result", payload: roomPayload() },
    ]);
    // The dropped queued copy still reports a clean delivery, with nothing emitted.
    expect(senderRouted).toStrictEqual({ delivered: true, targetCount: 0 });
    expect(roomRouted).toStrictEqual({ delivered: true, targetCount: 0 });
    // Fleet-wide key (no instance id), 600s, NX — the contract between both paths.
    expect(redis.set).toHaveBeenCalledWith(`msab:lucky:shown:lucky:result:${REF}`, "1", "EX", 600, "NX");
    expect(redis.set).toHaveBeenCalledWith(`msab:lucky:shown:lucky:room-result:${REF}`, "1", "EX", 600, "NX");
  });

  it("queued copy first, then the inline copy: still exactly one of each", async () => {
    await queuedSenderCopy("lucky:result", senderPayload());
    await queuedRoomCopy(roomPayload());
    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });

    expect(emitted("lucky:result")).toHaveLength(1);
    expect(emitted("lucky:room-result")).toHaveLength(1);
    // The inline entry is still counted as delivered by Laravel, even though MSAB dropped it.
    expect(metrics.giftLuckyInlineTotal.inc).toHaveBeenCalledWith({ kind: "result" });
  });

  it("contract fixture lucky_no_draw_payload: lucky:no-draw dedupes under its own event name", async () => {
    const noDraw = contract.lucky_no_draw_payload;
    expect(noDraw.reference_id).toBeTypeOf("string");

    await inlineCopy({ kind: "no-draw", sender: structuredClone(noDraw), room: null });
    await queuedSenderCopy("lucky:no-draw", structuredClone(noDraw));

    expect(emitted("lucky:no-draw")).toStrictEqual([
      { to: ["sock-1"], event: "lucky:no-draw", payload: noDraw },
    ]);
    expect(redis.store.has(`msab:lucky:shown:lucky:no-draw:${noDraw.reference_id}`)).toBe(true);
  });

  it("contract fixture inline_lucky_batch_response: the room payload carries reference_id, so the relayed room copy is dropped too", async () => {
    const entry = contract.inline_lucky_batch_response.lucky[0];
    expect(entry.room.reference_id).toBe(entry.sender.reference_id);

    await inlineCopy({ kind: "result", sender: structuredClone(entry.sender), room: structuredClone(entry.room) });
    await queuedSenderCopy("lucky:result", structuredClone(contract.lucky_result_payload));
    await queuedRoomCopy(structuredClone(entry.room));

    expect(emitted("lucky:result")).toHaveLength(1);
    expect(emitted("lucky:room-result")).toStrictEqual([
      { to: [String(ROOM_ID)], event: "lucky:room-result", payload: entry.room },
    ]);
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledWith({ event: "lucky:room-result", path: "queued" });
  });

  it("payload without reference_id: nothing to join on, so both copies emit as today and no claim is made", async () => {
    const { reference_id: _s, ...senderNoRef } = senderPayload();
    const { reference_id: _r, ...roomNoRef } = roomPayload();
    await inlineCopy({ kind: "result", sender: senderNoRef, room: roomNoRef });
    await queuedSenderCopy("lucky:result", senderNoRef);
    await queuedRoomCopy(roomNoRef);

    expect(emitted("lucky:result")).toHaveLength(2);
    expect(emitted("lucky:room-result")).toHaveLength(2);
    expect(
      redis.set.mock.calls.filter(([key]) => String(key).startsWith("msab:lucky:shown:")),
    ).toHaveLength(0);
  });

  it("Redis SET throws: fails open, both copies still emit (a rare duplicate beats a lost win)", async () => {
    redis.set.mockRejectedValue(new Error("redis down"));

    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });
    await queuedSenderCopy("lucky:result", senderPayload());
    await queuedRoomCopy(roomPayload());

    expect(emitted("lucky:result")).toHaveLength(2);
    expect(emitted("lucky:room-result")).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).not.toHaveBeenCalled();
  });

  it("inline sender leg with no live socket does not claim, so the queued copy can still show it", async () => {
    socketsBySender = {}; // sender offline when the batch response lands
    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });

    expect(emitted("lucky:result")).toHaveLength(0);
    expect(redis.store.has(`msab:lucky:shown:lucky:result:${REF}`)).toBe(false);
    // The room leg is independent of the sender's sockets and does claim.
    expect(emitted("lucky:room-result")).toHaveLength(1);

    socketsBySender = { [SENDER_ID]: ["sock-1"] }; // sender reconnects; outbox copy arrives
    await queuedSenderCopy("lucky:result", senderPayload());

    expect(emitted("lucky:result")).toHaveLength(1);
  });

  it("queued copy first while the sender has no socket: the claim is released, so the later inline copy still shows it once", async () => {
    socketsBySender = {}; // sender offline when the outbox copy is routed
    const routed = await queuedSenderCopy("lucky:result", senderPayload());

    expect(routed.delivered).toBe(false);
    expect(emitted("lucky:result")).toHaveLength(0);
    expect(redis.store.has(`msab:lucky:shown:lucky:result:${REF}`)).toBe(false);

    socketsBySender = { [SENDER_ID]: ["sock-1"] }; // sender reconnects; the batch response lands
    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });

    expect(emitted("lucky:result")).toHaveLength(1);
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).not.toHaveBeenCalledWith({ event: "lucky:result", path: "inline" });
  });

  it("routing throws after the lucky claim was won: the claim is released, so the later inline copy still shows it once", async () => {
    userSocketRepo.getSocketIds.mockRejectedValueOnce(new Error("socket lookup failed"));
    const routed = await queuedSenderCopy("lucky:result", senderPayload());

    expect(routed.delivered).toBe(false);
    expect(routed.error).toBe("socket lookup failed");
    expect(redis.store.has(`msab:lucky:shown:lucky:result:${REF}`)).toBe(false);

    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });

    expect(emitted("lucky:result")).toHaveLength(1);
  });

  it("routing throws after the lucky claim was won: a redelivered copy of the same envelope is not dropped as a duplicate", async () => {
    userSocketRepo.getSocketIds.mockRejectedValueOnce(new Error("socket lookup failed"));
    await queuedSenderCopy("lucky:result", senderPayload());

    const redelivered = await queuedSenderCopy("lucky:result", senderPayload());

    expect(redelivered.delivered).toBe(true);
    expect(emitted("lucky:result")).toHaveLength(1);
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).not.toHaveBeenCalled();
  });

  it("a failing release is silent: routing still reports the no-socket result", async () => {
    socketsBySender = {};
    redis.del.mockRejectedValue(new Error("redis down"));

    const routed = await queuedSenderCopy("lucky:result", senderPayload());

    expect(routed.delivered).toBe(false);
    expect(routed.error).toBeUndefined();
  });

  // ─── Seam 7: the dropped copy is counted, and never observed as latency ──

  it("a dropped queued copy increments flylive_gift_lucky_duplicate_dropped_total{path=queued} and skips the queued latency observation", async () => {
    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });
    await queuedSenderCopy("lucky:result", senderPayload());
    await queuedRoomCopy(roomPayload());

    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledTimes(2);
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledWith({ event: "lucky:result", path: "queued" });
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledWith({ event: "lucky:room-result", path: "queued" });
    // tapped_at is valid (NOW - 1500), so the winner observes and a non-dropped queued copy would too.
    expect(metrics.giftLuckyResultLatencySeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftLuckyResultLatencySeconds.observe).toHaveBeenCalledWith({ path: "inline" }, 1.5);
  });

  it("a dropped inline copy increments flylive_gift_lucky_duplicate_dropped_total{path=inline} and skips the inline latency observation", async () => {
    await queuedSenderCopy("lucky:result", senderPayload());
    await queuedRoomCopy(roomPayload());
    await inlineCopy({ kind: "result", sender: senderPayload(), room: roomPayload() });

    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledTimes(2);
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledWith({ event: "lucky:result", path: "inline" });
    expect(metrics.giftLuckyDuplicateDroppedTotal.inc).toHaveBeenCalledWith({ event: "lucky:room-result", path: "inline" });
    expect(metrics.giftLuckyResultLatencySeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftLuckyResultLatencySeconds.observe).toHaveBeenCalledWith({ path: "queued" }, 1.5);
  });
});
