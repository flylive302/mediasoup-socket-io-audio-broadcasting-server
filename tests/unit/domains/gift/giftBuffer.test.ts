import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";

// ─── Mock modules BEFORE importing the class ────────────────────────
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    GIFT_BUFFER_FLUSH_INTERVAL_MS: 5000,
    GIFT_MAX_RETRIES: 5,
    INSTANCE_ID: "i-test",
  },
}));

// ticket 04: dead-letter consumer reads the runtime TTL flag.
const PENDING_TTL_MS = 30_000;
// ticket 05: mutable so partition tests can flip it at runtime.
let flushPartitions = 1;
vi.mock("@src/domains/gift/flags.js", () => ({
  giftPendingTtlMs: () => PENDING_TTL_MS,
  giftFlushPartitions: () => flushPartitions,
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftBatchSize: { observe: vi.fn() },
    giftsProcessed: { inc: vi.fn() },
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
  },
}));

import {
  GiftBuffer,
  DEAD_LETTER_MAX_LENGTH,
  DEAD_LETTER_HIGH_WATER,
  DEAD_LETTER_CONSUMER_INTERVAL_MS,
} from "@src/domains/gift/giftBuffer.js";
import { metrics } from "@src/infrastructure/metrics.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRedis() {
  const pipeline = {
    rpush: vi.fn().mockReturnThis(),
    ltrim: vi.fn().mockReturnThis(),
    lrem: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  // ticket 04: eval serves three scripts — claim (2 keys, returns items),
  // move-all (2 keys, returns count) and the DLQ pop (1 key, returns items).
  // Tests set `_claimItems` / `_dlqItems` / `_moved`; scripts are told apart
  // by their key arguments.
  const redis = {
    _claimItems: [] as string[],
    _dlqItems: [] as string[],
    _moved: 0,
    rpush: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue("OK"),
    llen: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
    eval: vi.fn(),
  };
  redis.eval.mockImplementation(async (_lua: string, numKeys: number, k1: string, k2?: string) => {
    if (numKeys === 2 && k1 === "gifts:pending") return redis._claimItems;
    // ticket 05: only partition 0's in-flight list carries `_moved`; the
    // other 15 partition keys (also swept at boot) are empty.
    if (numKeys === 2 && k1 === "gifts:inflight:i-test" && k2 === "gifts:pending") return redis._moved;
    if (numKeys === 2 && k1.startsWith("gifts:inflight:")) return 0;
    if (numKeys === 2 && k1.startsWith("gifts:pending:") && k2 === "gifts:pending") return 0;
    if (numKeys === 1 && k1 === "gifts:dead_letter") return redis._dlqItems;
    return [];
  });
  return redis;
}

function createMockLaravelClient() {
  return {
    processGiftBatch: vi.fn().mockResolvedValue({ failed: [] }),
  };
}

function createMockIo() {
  const emitFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    _emit: emitFn,
  };
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeGiftJSON(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    transaction_id: "tx-1",
    room_id: "room-1",
    sender_id: 1,
    recipient_ids: [2],
    gift_id: 100,
    quantity: 1,
    timestamp: Date.now(),
    sender_socket_id: "sock-1",
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("GiftBuffer", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRedis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLaravel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockIo: any;
  let buffer: GiftBuffer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRedis = createMockRedis();
    mockLaravel = createMockLaravelClient();
    mockIo = createMockIo();
    const mockLogger = createMockLogger();
    // Create buffer WITHOUT calling start() so flush tests run manually
    buffer = new GiftBuffer(
      mockRedis as Redis,
      mockLaravel,
      mockIo,
      mockLogger,
    );
  });

  // ─── enqueue ──────────────────────────────────────────────────────

  it("pushes gift as JSON to Redis queue", async () => {
    const gift = {
      transaction_id: "tx-1",
      room_id: "room-1",
      sender_id: 1,
      recipient_ids: [2],
      gift_id: 100,
      quantity: 1,
      timestamp: Date.now(),
      sender_socket_id: "sock-1",
    };

    await buffer.enqueue(gift);

    expect(mockRedis.rpush).toHaveBeenCalledWith(
      "gifts:pending",
      JSON.stringify(gift),
    );
  });

  // ─── flush: empty queue ───────────────────────────────────────────

  it("skips processing when queue is empty (eval returns empty array)", async () => {
    mockRedis._claimItems = [];

    // Trigger flush via stop()
    await buffer.stop();

    expect(mockRedis.eval).toHaveBeenCalled();
    expect(mockLaravel.processGiftBatch).not.toHaveBeenCalled();
  });

  // ─── flush: gift-authority-tick-fanout 01 — queue depth gauge ──────

  it("samples giftQueueDepth from pendingCount() once per flush tick, even when the queue is empty", async () => {
    mockRedis._claimItems = [];
    mockRedis.llen.mockResolvedValue(7);

    await buffer.stop(); // one flush tick (waitForIdle + final flush both no-op past the first)

    expect(mockRedis.llen).toHaveBeenCalledWith("gifts:pending");
    expect(metrics.giftQueueDepth.set).toHaveBeenCalledWith(7);
  });

  it("does not publish a bogus giftQueueDepth when pendingCount() falls back to the -1 sentinel", async () => {
    mockRedis._claimItems = [];
    mockRedis.llen.mockRejectedValue(new Error("redis down"));

    await buffer.stop();

    expect(metrics.giftQueueDepth.set).not.toHaveBeenCalled();
  });

  // ─── flush: happy path ────────────────────────────────────────────

  it("processes batch through Laravel and deletes processing key on success", async () => {
    const giftJson = makeGiftJSON();
    // Lua script returns items directly
    mockRedis._claimItems = [giftJson];

    await buffer.stop();

    expect(mockLaravel.processGiftBatch).toHaveBeenCalledWith([
      JSON.parse(giftJson),
    ]);
    expect(metrics.giftBatchSize.observe).toHaveBeenCalledWith({ partition: "0" }, 1);
    expect(metrics.giftsProcessed.inc).toHaveBeenCalledWith(
      { status: "success" },
      1,
    );
  });

  // ─── flush: gift-path-latency 11 metrics (buffer wait + batch POST) ──

  it("observes one giftBufferWaitSeconds sample per transaction, equal to (flushTime - timestamp)/1000", async () => {
    const flushTime = 1_700_000_010_000;
    vi.setSystemTime(flushTime);

    const gift1 = makeGiftJSON({ transaction_id: "tx-1", timestamp: flushTime - 1000 });
    const gift2 = makeGiftJSON({ transaction_id: "tx-2", timestamp: flushTime - 500 });
    mockRedis._claimItems = [gift1, gift2];

    await buffer.stop();

    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledTimes(2);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenNthCalledWith(1, { attempt: "first", partition: "0" }, 1);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenNthCalledWith(2, { attempt: "first", partition: "0" }, 0.5);
  });

  it("skips observing wait time for a transaction with a future timestamp (negative wait)", async () => {
    const flushTime = 1_700_000_010_000;
    vi.setSystemTime(flushTime);

    // One normal (past) transaction and one with a future timestamp (clock skew / bad stamp).
    const pastGift = makeGiftJSON({ transaction_id: "tx-1", timestamp: flushTime - 1000 });
    const futureGift = makeGiftJSON({ transaction_id: "tx-2", timestamp: flushTime + 5000 });
    mockRedis._claimItems = [pastGift, futureGift];

    await buffer.stop();

    // Only the past-timestamp transaction is observed — count matters, not just sign.
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledWith({ attempt: "first", partition: "0" }, 1);
  });

  it("labels giftBufferWaitSeconds by attempt: \"first\" for a fresh gift, \"retried\" for one with retryCount >= 1, discriminated within the same flush", async () => {
    const flushTime = 1_700_000_010_000;
    vi.setSystemTime(flushTime);

    // Same flush, one of each kind — the discrimination itself is what's under test.
    const freshGift = makeGiftJSON({
      transaction_id: "tx-1",
      timestamp: flushTime - 1000,
    });
    const retriedGift = makeGiftJSON({
      transaction_id: "tx-2",
      timestamp: flushTime - 2000,
      retryCount: 2,
    });
    mockRedis._claimItems = [freshGift, retriedGift];

    await buffer.stop();

    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledTimes(2);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledWith({ attempt: "first", partition: "0" }, 1);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledWith({ attempt: "retried", partition: "0" }, 2);
  });

  it("observes exactly one giftBatchPostSeconds sample under outcome=success on a successful batch POST", async () => {
    const giftJson = makeGiftJSON();
    mockRedis._claimItems = [giftJson];
    // default mockLaravel.processGiftBatch resolves { failed: [] }

    await buffer.stop();

    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledWith(
      { outcome: "success", partition: "0" },
      expect.any(Number),
    );
    expect(metrics.giftBatchPostSeconds.observe).not.toHaveBeenCalledWith(
      { outcome: "failure", partition: "0" },
      expect.anything(),
    );
  });

  it("observes exactly one giftBatchPostSeconds sample under outcome=failure when the batch POST rejects, unconfused by the per-item fallback", async () => {
    const giftJson = makeGiftJSON();
    mockRedis._claimItems = [giftJson];
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("Network error"));

    await buffer.stop();

    // Sanity check: the per-item fallback really did re-invoke processGiftBatch
    // beyond the initial batch-level call, so the assertion below is proven to
    // be about the batch-level histogram, not accidentally passing because the
    // fallback never ran.
    expect(mockLaravel.processGiftBatch).toHaveBeenCalledTimes(2);

    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledWith(
      { outcome: "failure", partition: "0" },
      expect.any(Number),
    );
    expect(metrics.giftBatchPostSeconds.observe).not.toHaveBeenCalledWith(
      { outcome: "success", partition: "0" },
      expect.anything(),
    );
  });

  // The four tests above assert against the vi.fn() spies this file mocks
  // @src/infrastructure/metrics.js into — they prove giftBuffer.ts CALLS the
  // histograms correctly, but a mocked module means they can't see whether the
  // real histograms in metrics.ts have the right Prometheus name, buckets or
  // labels. This test bypasses just that one mock via vi.importActual to check
  // the real definitions, without touching the vi.mock/spy setup above.
  it("defines the real giftBufferWaitSeconds / giftBatchPostSeconds histograms with the documented name, buckets and attempt/outcome labels", async () => {
    const actual = await vi.importActual<typeof import("@src/infrastructure/metrics.js")>(
      "@src/infrastructure/metrics.js",
    );

    actual.metrics.giftBufferWaitSeconds.observe({ attempt: "first", partition: "0" }, 0.2);
    actual.metrics.giftBufferWaitSeconds.observe({ attempt: "retried", partition: "0" }, 0.3);
    const waitText = await actual.metricsRegistry.getSingleMetricAsString(
      "flylive_gift_buffer_wait_seconds",
    );
    expect(waitText).toContain("# TYPE flylive_gift_buffer_wait_seconds histogram");
    expect(waitText).toContain('attempt="first"');
    expect(waitText).toContain('attempt="retried"');
    for (const bucket of [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5]) {
      expect(waitText).toContain(`le="${bucket}"`);
    }

    actual.metrics.giftBatchPostSeconds.observe({ outcome: "success", partition: "0" }, 0.3);
    actual.metrics.giftBatchPostSeconds.observe({ outcome: "failure", partition: "0" }, 0.4);
    const postText = await actual.metricsRegistry.getSingleMetricAsString(
      "flylive_gift_batch_post_seconds",
    );
    expect(postText).toContain("# TYPE flylive_gift_batch_post_seconds histogram");
    expect(postText).toContain('outcome="success"');
    expect(postText).toContain('outcome="failure"');
    for (const bucket of [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10]) {
      expect(postText).toContain(`le="${bucket}"`);
    }
  });

  // ─── flush: authoritative sender balance relay (Epic B 06) ────────

  it("emits balance.updated to the sender socket from the batch response's processed entries", async () => {
    const giftJson = makeGiftJSON();
    mockRedis._claimItems = [giftJson];
    const balance = {
      coins: "49500",
      diamonds: "10",
      wealth_xp: "123.5",
      charm_xp: "0",
    };
    mockLaravel.processGiftBatch.mockResolvedValue({
      failed: [],
      processed: [
        { transaction_ids: ["tx-1"], sender_id: 1, balance },
      ],
    });

    await buffer.stop();

    expect(mockIo.to).toHaveBeenCalledWith("sock-1");
    expect(mockIo._emit).toHaveBeenCalledWith("balance.updated", balance);
  });

  it("stays silent when the batch response has no processed entries (older Laravel)", async () => {
    const giftJson = makeGiftJSON();
    mockRedis._claimItems = [giftJson];
    mockLaravel.processGiftBatch.mockResolvedValue({ failed: [] });

    await buffer.stop();

    expect(mockIo._emit).not.toHaveBeenCalledWith(
      "balance.updated",
      expect.anything(),
    );
  });

  // ─── flush: Laravel failures ──────────────────────────────────────

  it("emits gift:error for Laravel-reported failures", async () => {
    const giftJson = makeGiftJSON();
    mockRedis._claimItems = [giftJson];
    mockLaravel.processGiftBatch.mockResolvedValue({
      failed: [
        {
          transaction_id: "tx-1",
          sender_socket_id: "sock-1",
          code: "BALANCE_TOO_LOW",
          reason: "Insufficient balance",
        },
      ],
    });

    await buffer.stop();

    expect(mockIo.to).toHaveBeenCalledWith("sock-1");
    expect(mockIo._emit).toHaveBeenCalledWith("gift:error", {
      transactionId: "tx-1",
      code: "BALANCE_TOO_LOW",
      reason: "Insufficient balance",
    });
    expect(metrics.giftsProcessed.inc).toHaveBeenCalledWith({
      status: "failed",
    });
  });

  // ─── flush: network error → re-queue ──────────────────────────────

  it("re-queues items with incremented retryCount on Laravel error", async () => {
    const giftJson = makeGiftJSON();
    mockRedis._claimItems = [giftJson];
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("Network error"));

    await buffer.stop();

    const pipeline = mockRedis._pipeline;
    expect(pipeline.rpush).toHaveBeenCalledWith(
      "gifts:pending",
      expect.stringContaining('"retryCount":1'),
    );
    expect(pipeline.exec).toHaveBeenCalled();
  });

  // ─── flush: max retries → dead-letter ─────────────────────────────

  it("moves to dead-letter queue when retryCount exceeds max", async () => {
    const giftJson = makeGiftJSON({ retryCount: 5 });
    mockRedis._claimItems = [giftJson];
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("Network error"));

    await buffer.stop();

    const pipeline = mockRedis._pipeline;
    expect(pipeline.rpush).toHaveBeenCalledWith(
      "gifts:dead_letter",
      expect.any(String),
    );
    // ticket 04: no unconditional trim any more — llen is 0 here, so nothing
    // is destroyed (see the cap/high-water tests below).
    expect(pipeline.ltrim).not.toHaveBeenCalled();
    expect(mockRedis.ltrim).not.toHaveBeenCalled();
    expect(metrics.giftsProcessed.inc).toHaveBeenCalledWith({
      status: "dead_letter",
    });
    // Verify sender is notified of permanent failure
    expect(mockIo.to).toHaveBeenCalledWith("sock-1");
    expect(mockIo._emit).toHaveBeenCalledWith("gift:error", {
      transactionId: "tx-1",
      code: "PROCESSING_FAILED",
      reason: "Gift processing failed after multiple attempts",
    });
  });

  // ─── GF-003: corrupted JSON handling ──────────────────────────────

  it("handles corrupted JSON entries gracefully (GF-003)", async () => {
    const validJson = makeGiftJSON();
    const corruptedEntry = "{invalid_json!!!";
    // Lua script returns both items directly
    mockRedis._claimItems = [corruptedEntry, validJson];

    await buffer.stop();

    // Corrupted entry goes to dead-letter
    expect(mockRedis.rpush).toHaveBeenCalledWith(
      "gifts:dead_letter",
      corruptedEntry,
    );
    // Valid entry still processed normally
    expect(mockLaravel.processGiftBatch).toHaveBeenCalledWith([
      JSON.parse(validJson),
    ]);
  });

  it("cleans up when all items are corrupted (GF-003)", async () => {
    // Lua script returns corrupted items directly
    mockRedis._claimItems = ["{corrupt1", "{corrupt2"];

    await buffer.stop();

    // Both entries go to dead-letter
    expect(mockRedis.rpush).toHaveBeenCalledTimes(2);
    // Laravel should NOT be called
    expect(mockLaravel.processGiftBatch).not.toHaveBeenCalled();
  });

  // ─── GF-006 + GF-014: dead-letter queue size monitoring (sampled) ──

  it("reports dead-letter queue size metric on 10th flush (GF-006, GF-014)", async () => {
    const giftJson = makeGiftJSON();
    mockRedis.llen.mockResolvedValue(42);

    // GF-014: DLQ size is sampled every 10th flush.
    // Trigger 9 empty flushes via start() + advanceTimersByTime, then stop() for the 10th.
    mockRedis._claimItems = []; // empty queue for first 9 flushes
    buffer.start();
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    // 10th flush: has data
    mockRedis._claimItems = [giftJson];
    await buffer.stop();

    expect(mockRedis.llen).toHaveBeenCalledWith("gifts:dead_letter");
    expect(metrics.giftDeadLetterSize.set).toHaveBeenCalledWith(42);
  });

  // ─── F-39: stop() waits for an in-flight flush before returning ─────

  it("stop() awaits an in-flight flush instead of no-op'ing on the isFlushing guard (F-39)", async () => {
    vi.useRealTimers(); // real timers — the waitForIdle loop uses 50ms polls

    // First flush call is "in-flight": never resolves until we let it.
    let releaseFirst!: (v: unknown[]) => void;
    const firstFlushItems = new Promise<unknown[]>((resolve) => {
      releaseFirst = resolve;
    });
    // The Lua LPOP_N call is the awaited primitive in flush(); make it hang
    // on the first call and resolve to [] on the final stop()-driven call.
    mockRedis.eval
      .mockReturnValueOnce(firstFlushItems)
      .mockResolvedValueOnce([]);

    // Kick off the "in-flight" flush (no await).
    const inFlight = (buffer as unknown as { flush(): Promise<void> }).flush();

    // stop() runs while isFlushing is still true; it must NOT no-op.
    const stopped = buffer.stop();

    // Drive the in-flight flush to completion.
    releaseFirst([]);
    await inFlight;
    await stopped;

    // The final-flush call inside stop() must have actually called eval again.
    // (First call = in-flight, second = final flush during stop, third = the
    // ticket-04 in-flight→pending return at shutdown.)
    expect(mockRedis.eval).toHaveBeenCalledTimes(3);
  });
});

// ─── Redis degradation instrumentation (platform-security 07) ───────
//
// pendingCount() was the epic's one FULLY silent degradation path: it caught
// a Redis error, emitted neither log nor metric, and returned -1. The sentinel
// is load-bearing (callers distinguish "unknown" from "zero"), so these tests
// pin that it is unchanged — the ticket adds observability, never behaviour.


// ─── gift-authority-tick-fanout 04: claim-based flush + dead-letter consumer ──

describe("GiftBuffer — ticket 04 claim / reclaim / dead-letter consumer", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRedis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLaravel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockIo: any;
  let mockLogger: Logger;
  let buffer: GiftBuffer;
  const INFLIGHT = "gifts:inflight:i-test";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRedis = createMockRedis();
    mockLaravel = createMockLaravelClient();
    mockIo = createMockIo();
    mockLogger = createMockLogger();
    buffer = new GiftBuffer(mockRedis as Redis, mockLaravel, mockIo, mockLogger);
  });

  it("claims into the per-instance in-flight list (2-key script) instead of popping", async () => {
    mockRedis._claimItems = [makeGiftJSON()];
    await buffer.stop();
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("rpush"),
      2,
      "gifts:pending",
      INFLIGHT,
      50,
    );
  });

  it("releases the claim (LREM in-flight) only after a successful booking response", async () => {
    const raw = makeGiftJSON();
    mockRedis._claimItems = [raw];
    let released = false;
    mockRedis._pipeline.lrem.mockImplementation(() => {
      released = true;
      return mockRedis._pipeline;
    });
    mockLaravel.processGiftBatch.mockImplementation(async () => {
      expect(released).toBe(false); // still claimed while the POST is in flight
      return { failed: [] };
    });

    await buffer.stop();

    expect(mockRedis._pipeline.lrem).toHaveBeenCalledWith(INFLIGHT, 1, raw);
    expect(mockRedis._pipeline.exec).toHaveBeenCalled();
  });

  it("per-item fallback releases each claim in the same pipeline as its re-queue / dead-letter", async () => {
    const raw = makeGiftJSON();
    mockRedis._claimItems = [raw];
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("down"));

    await buffer.stop();

    const p = mockRedis._pipeline;
    expect(p.lrem).toHaveBeenCalledWith(INFLIGHT, 1, raw);
    expect(p.rpush).toHaveBeenCalledWith("gifts:pending", expect.stringContaining('"retryCount":1'));
  });

  it("returns the claimed batch to pending when Redis throws inside the flush", async () => {
    const raw = makeGiftJSON();
    mockRedis._claimItems = [raw];
    // First pipeline (release after success) explodes at exec.
    mockRedis._pipeline.exec
      .mockRejectedValueOnce(new Error("redis gone"))
      .mockResolvedValue([]);

    await buffer.stop();

    const p = mockRedis._pipeline;
    expect(p.rpush).toHaveBeenCalledWith("gifts:pending", raw);
    expect(p.lrem).toHaveBeenCalledWith(INFLIGHT, 1, raw);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ batchSize: 1 }),
      expect.stringContaining("returning claimed batch to pending"),
    );
    // flush lock released: a second flush (stop's final one already ran) must be possible
    mockRedis._claimItems = [];
    await expect(buffer.stop()).resolves.toBeUndefined();
  });

  it("boot: moves this instance's in-flight list back to pending BEFORE the first flush tick and logs the count", async () => {
    mockRedis._moved = 7;
    const order: string[] = [];
    mockRedis.eval.mockImplementation(async (_l: string, n: number, k1: string) => {
      if (n === 2 && k1 === INFLIGHT) { order.push("reclaim"); return 7; }
      if (n === 2 && k1.startsWith("gifts:inflight:")) return 0;
      if (n === 2 && k1 === "gifts:pending") { order.push("claim"); return []; }
      return [];
    });

    buffer.start();
    await buffer.started;
    await vi.advanceTimersByTimeAsync(5000);

    expect(order[0]).toBe("reclaim");
    expect(order).toContain("claim");
    expect(metrics.giftInflightReclaimed.inc).toHaveBeenCalledWith(7);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reclaimed: 7, key: INFLIGHT }),
      expect.stringContaining("reclaimed"),
    );
    await buffer.stop();
  });

  it("boot reclaim failure is logged and the flush timer still starts", async () => {
    mockRedis.eval.mockImplementation(async (_l: string, n: number, k1: string) => {
      if (n === 2 && k1 === INFLIGHT) throw new Error("redis down");
      if (n === 2 && k1.startsWith("gifts:inflight:")) return 0;
      return [];
    });
    buffer.start();
    await buffer.started;
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: INFLIGHT }),
      expect.stringContaining("reclaim failed"),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), 2, "gifts:pending", INFLIGHT, 50);
    await buffer.stop();
  });

  it("graceful stop returns any leftover in-flight items to pending", async () => {
    mockRedis._moved = 3;
    await buffer.stop();
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.stringContaining("moved"), 2, INFLIGHT, "gifts:pending");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ returned: 3 }),
      expect.stringContaining("returned to pending at shutdown"),
    );
  });

  describe("dead-letter consumer", () => {
    it("does not replay while the last booking call failed", async () => {
      mockRedis._dlqItems = [makeGiftJSON()];
      await buffer.replayDeadLetters();
      expect(mockRedis.eval).not.toHaveBeenCalledWith(expect.any(String), 1, "gifts:dead_letter", expect.anything());
    });

    it("re-queues young gifts with a fresh retry budget and drops ones older than GIFT_PENDING_TTL_MS", async () => {
      // Make the backend healthy first via a successful (empty-claim) flush path.
      mockRedis._claimItems = [makeGiftJSON({ transaction_id: "warm" })];
      await buffer.stop();
      vi.clearAllMocks();

      const now = Date.now();
      mockRedis._dlqItems = [
        makeGiftJSON({ transaction_id: "young", timestamp: now - PENDING_TTL_MS / 2, retryCount: 5 }),
        makeGiftJSON({ transaction_id: "old", timestamp: now - PENDING_TTL_MS - 1 }),
        "{not json",
      ];

      await buffer.replayDeadLetters();

      const p = mockRedis._pipeline;
      expect(p.rpush).toHaveBeenCalledTimes(1);
      expect(p.rpush).toHaveBeenCalledWith("gifts:pending", expect.stringContaining('"transaction_id":"young"'));
      expect(p.rpush).toHaveBeenCalledWith("gifts:pending", expect.stringContaining('"retryCount":0'));
      expect(metrics.giftDeadLetterReplayed.inc).toHaveBeenCalledWith(1);
      expect(metrics.giftDeadLetterExpired.inc).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: "old" }),
        expect.stringContaining("older than GIFT_PENDING_TTL_MS"),
      );
    });

    it("runs on its own 30 s interval once started", async () => {
      mockRedis._claimItems = [makeGiftJSON()];
      buffer.start();
      await buffer.started;
      await vi.advanceTimersByTimeAsync(5000); // one flush → lastBookingOk
      mockRedis._claimItems = [];
      vi.clearAllMocks();
      mockRedis.eval.mockImplementation(async (_l: string, n: number, k1: string) =>
        n === 1 && k1 === "gifts:dead_letter" ? [] : n === 2 && k1.startsWith("gifts:inflight:") ? 0 : []);

      await vi.advanceTimersByTimeAsync(DEAD_LETTER_CONSUMER_INTERVAL_MS);

      expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), 1, "gifts:dead_letter", 50);
      await buffer.stop();
    });
  });

  describe("dead-letter cap", () => {
    it("logs at error + increments high-water above 80% of the cap, without trimming", async () => {
      mockRedis._claimItems = [makeGiftJSON({ retryCount: 5 })];
      mockLaravel.processGiftBatch.mockRejectedValue(new Error("down"));
      mockRedis.llen.mockResolvedValue(DEAD_LETTER_HIGH_WATER + 1);

      await buffer.stop();

      expect(metrics.giftDeadLetterHighWater.inc).toHaveBeenCalled();
      expect(mockRedis.ltrim).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ dlqSize: DEAD_LETTER_HIGH_WATER + 1 }),
        expect.stringContaining("80%"),
      );
    });

    it("trims only above the cap and logs how many were destroyed", async () => {
      mockRedis._claimItems = [makeGiftJSON({ retryCount: 5 })];
      mockLaravel.processGiftBatch.mockRejectedValue(new Error("down"));
      mockRedis.llen.mockResolvedValue(DEAD_LETTER_MAX_LENGTH + 25);

      await buffer.stop();

      expect(mockRedis.ltrim).toHaveBeenCalledWith("gifts:dead_letter", -DEAD_LETTER_MAX_LENGTH, -1);
      expect(metrics.giftDeadLetterTrimmed.inc).toHaveBeenCalledWith(25);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ trimmed: 25 }),
        expect.stringContaining("ABOVE CAP"),
      );
    });

    it("cap constant is 50 000", () => {
      expect(DEAD_LETTER_MAX_LENGTH).toBe(50_000);
    });
  });
});


// ─── gift-authority-tick-fanout 05: sender-partitioned parallel flush ──────

describe("GiftBuffer — ticket 05 partitions", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRedis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLaravel: any;
  let mockLogger: Logger;
  let buffer: GiftBuffer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    flushPartitions = 1;
    mockRedis = createMockRedis();
    mockLaravel = createMockLaravelClient();
    mockLogger = createMockLogger();
    buffer = new GiftBuffer(mockRedis as Redis, mockLaravel, createMockIo(), mockLogger);
  });

  it("partitions=1 (default) uses exactly today's keys — gifts:pending and the unsuffixed in-flight list", async () => {
    await buffer.enqueue(JSON.parse(makeGiftJSON({ sender_id: 7 })));
    expect(mockRedis.rpush).toHaveBeenCalledWith("gifts:pending", expect.any(String));
    mockRedis._claimItems = [makeGiftJSON()];
    await buffer.stop();
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), 2, "gifts:pending", "gifts:inflight:i-test", 50);
    expect(mockRedis.eval).not.toHaveBeenCalledWith(expect.any(String), 2, "gifts:pending:1", expect.anything(), 50);
  });

  it("routes enqueue by sender_id mod partitions", async () => {
    flushPartitions = 4;
    await buffer.enqueue(JSON.parse(makeGiftJSON({ sender_id: 5 })));
    await buffer.enqueue(JSON.parse(makeGiftJSON({ sender_id: 8 })));
    expect(mockRedis.rpush).toHaveBeenCalledWith("gifts:pending:1", expect.any(String));
    expect(mockRedis.rpush).toHaveBeenCalledWith("gifts:pending", expect.any(String));
  });

  it("claims every active partition on a tick, each into its own in-flight list", async () => {
    flushPartitions = 3;
    await buffer.stop(); // one flushAll
    for (const [q, i] of [["gifts:pending", "gifts:inflight:i-test"], ["gifts:pending:1", "gifts:inflight:i-test:1"], ["gifts:pending:2", "gifts:inflight:i-test:2"]]) {
      expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), 2, q, i, 50);
    }
    expect(mockLogger.info).toHaveBeenCalledWith({ from: 1, to: 3 }, "Gift flush partitions changed");
  });

  it("a hung backend call on one partition does not delay the others", async () => {
    flushPartitions = 2;
    let releaseP0!: () => void;
    const hang = new Promise<{ failed: never[] }>((r) => { releaseP0 = () => r({ failed: [] }); });
    mockRedis.eval.mockImplementation(async (_l: string, n: number, k1: string) => {
      if (n === 2 && k1 === "gifts:pending") return [makeGiftJSON({ transaction_id: "p0", sender_id: 0 })];
      if (n === 2 && k1 === "gifts:pending:1") return [makeGiftJSON({ transaction_id: "p1", sender_id: 1 })];
      return n === 2 ? 0 : [];
    });
    mockLaravel.processGiftBatch.mockImplementation(async (txs: Array<{ transaction_id: string }>) =>
      txs[0]!.transaction_id === "p0" ? hang : { failed: [] });

    buffer.start();
    await buffer.started;
    await vi.advanceTimersByTimeAsync(5000);

    // p1 booked while p0 is still hung
    expect(metrics.giftsProcessed.inc).toHaveBeenCalledWith({ status: "success" }, 1);
    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledWith({ outcome: "success", partition: "1" }, expect.any(Number));
    expect(metrics.giftBatchPostSeconds.observe).not.toHaveBeenCalledWith({ outcome: "success", partition: "0" }, expect.any(Number));

    // next tick: p1 flushes again, p0 still guarded (no second claim on p0)
    const p0Claims = () => mockRedis.eval.mock.calls.filter((c: unknown[]) => c[2] === "gifts:pending").length;
    const before = p0Claims();
    await vi.advanceTimersByTimeAsync(5000);
    expect(p0Claims()).toBe(before);

    releaseP0();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await buffer.stop();
  });

  it("shrinking the partition count drains orphaned partitions into partition 0", async () => {
    flushPartitions = 3;
    await buffer.stop();
    vi.clearAllMocks();
    flushPartitions = 1;
    mockRedis.eval.mockImplementation(async (_l: string, n: number, k1: string, k2?: string) => {
      if (n === 2 && k1 === "gifts:pending:2" && k2 === "gifts:pending") return 4;
      return n === 2 && !k1.startsWith("gifts:pending") ? 0 : n === 2 && k1.startsWith("gifts:pending:") ? 0 : [];
    });
    await buffer.stop();
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.stringContaining("moved"), 2, "gifts:pending:1", "gifts:pending");
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.stringContaining("moved"), 2, "gifts:pending:2", "gifts:pending");
    expect(mockLogger.warn).toHaveBeenCalledWith({ partition: 2, moved: 4 }, "Orphaned partition drained into partition 0");
  });

  it("pendingCount sums every active partition", async () => {
    flushPartitions = 2;
    await buffer.stop(); // syncs partitions
    mockRedis.llen.mockImplementation(async (k: string) => (k === "gifts:pending" ? 3 : k === "gifts:pending:1" ? 4 : 0));
    expect(await buffer.pendingCount()).toBe(7);
  });
});

describe("GiftBuffer.pendingCount — Redis degradation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRedis: any;
  let mockLogger: Logger;
  let buffer: GiftBuffer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = createMockRedis();
    mockLogger = createMockLogger();
    buffer = new GiftBuffer(
      mockRedis as Redis,
      createMockLaravelClient(),
      createMockIo(),
      mockLogger,
    );
  });

  it("returns the real queue length when Redis is healthy", async () => {
    mockRedis.llen.mockResolvedValue(42);

    await expect(buffer.pendingCount()).resolves.toBe(42);
    expect(metrics.redisDegradations.inc).not.toHaveBeenCalled();
  });

  it("still returns the -1 sentinel when Redis fails — behaviour unchanged", async () => {
    mockRedis.llen.mockRejectedValue(new Error("READONLY"));

    await expect(buffer.pendingCount()).resolves.toBe(-1);
  });

  it("now records the degradation and logs it, instead of failing silently", async () => {
    mockRedis.llen.mockRejectedValue(new Error("READONLY"));

    await buffer.pendingCount();

    expect(metrics.redisDegradations.inc).toHaveBeenCalledWith({
      subsystem: "gift-buffer",
      operation: "pending-count",
    });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("does not let a throwing metrics backend break the sentinel", async () => {
    mockRedis.llen.mockRejectedValue(new Error("READONLY"));
    vi.mocked(metrics.redisDegradations.inc).mockImplementationOnce(() => {
      throw new Error("prom-client exploded");
    });

    // The helper swallows it — the caller still gets its fallback rather than
    // an unhandled rejection.
    await expect(buffer.pendingCount()).resolves.toBe(-1);
  });
});
