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
  },
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
  },
}));

import { GiftBuffer } from "@src/domains/gift/giftBuffer.js";
import { metrics } from "@src/infrastructure/metrics.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRedis() {
  const pipeline = {
    rpush: vi.fn().mockReturnThis(),
    ltrim: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    rpush: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue([]),   // Lua script returns array of items (empty = no items)
    llen: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
  };
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
    mockRedis.eval.mockResolvedValue([]);

    // Trigger flush via stop()
    await buffer.stop();

    expect(mockRedis.eval).toHaveBeenCalled();
    expect(mockLaravel.processGiftBatch).not.toHaveBeenCalled();
  });

  // ─── flush: gift-authority-tick-fanout 01 — queue depth gauge ──────

  it("samples giftQueueDepth from pendingCount() once per flush tick, even when the queue is empty", async () => {
    mockRedis.eval.mockResolvedValue([]);
    mockRedis.llen.mockResolvedValue(7);

    await buffer.stop(); // one flush tick (waitForIdle + final flush both no-op past the first)

    expect(mockRedis.llen).toHaveBeenCalledWith("gifts:pending");
    expect(metrics.giftQueueDepth.set).toHaveBeenCalledWith(7);
  });

  it("does not publish a bogus giftQueueDepth when pendingCount() falls back to the -1 sentinel", async () => {
    mockRedis.eval.mockResolvedValue([]);
    mockRedis.llen.mockRejectedValue(new Error("redis down"));

    await buffer.stop();

    expect(metrics.giftQueueDepth.set).not.toHaveBeenCalled();
  });

  // ─── flush: happy path ────────────────────────────────────────────

  it("processes batch through Laravel and deletes processing key on success", async () => {
    const giftJson = makeGiftJSON();
    // Lua script returns items directly
    mockRedis.eval.mockResolvedValue([giftJson]);

    await buffer.stop();

    expect(mockLaravel.processGiftBatch).toHaveBeenCalledWith([
      JSON.parse(giftJson),
    ]);
    expect(metrics.giftBatchSize.observe).toHaveBeenCalledWith(1);
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
    mockRedis.eval.mockResolvedValue([gift1, gift2]);

    await buffer.stop();

    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledTimes(2);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenNthCalledWith(1, { attempt: "first" }, 1);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenNthCalledWith(2, { attempt: "first" }, 0.5);
  });

  it("skips observing wait time for a transaction with a future timestamp (negative wait)", async () => {
    const flushTime = 1_700_000_010_000;
    vi.setSystemTime(flushTime);

    // One normal (past) transaction and one with a future timestamp (clock skew / bad stamp).
    const pastGift = makeGiftJSON({ transaction_id: "tx-1", timestamp: flushTime - 1000 });
    const futureGift = makeGiftJSON({ transaction_id: "tx-2", timestamp: flushTime + 5000 });
    mockRedis.eval.mockResolvedValue([pastGift, futureGift]);

    await buffer.stop();

    // Only the past-timestamp transaction is observed — count matters, not just sign.
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledWith({ attempt: "first" }, 1);
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
    mockRedis.eval.mockResolvedValue([freshGift, retriedGift]);

    await buffer.stop();

    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledTimes(2);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledWith({ attempt: "first" }, 1);
    expect(metrics.giftBufferWaitSeconds.observe).toHaveBeenCalledWith({ attempt: "retried" }, 2);
  });

  it("observes exactly one giftBatchPostSeconds sample under outcome=success on a successful batch POST", async () => {
    const giftJson = makeGiftJSON();
    mockRedis.eval.mockResolvedValue([giftJson]);
    // default mockLaravel.processGiftBatch resolves { failed: [] }

    await buffer.stop();

    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledWith(
      { outcome: "success" },
      expect.any(Number),
    );
    expect(metrics.giftBatchPostSeconds.observe).not.toHaveBeenCalledWith(
      { outcome: "failure" },
      expect.anything(),
    );
  });

  it("observes exactly one giftBatchPostSeconds sample under outcome=failure when the batch POST rejects, unconfused by the per-item fallback", async () => {
    const giftJson = makeGiftJSON();
    mockRedis.eval.mockResolvedValue([giftJson]);
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("Network error"));

    await buffer.stop();

    // Sanity check: the per-item fallback really did re-invoke processGiftBatch
    // beyond the initial batch-level call, so the assertion below is proven to
    // be about the batch-level histogram, not accidentally passing because the
    // fallback never ran.
    expect(mockLaravel.processGiftBatch).toHaveBeenCalledTimes(2);

    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledTimes(1);
    expect(metrics.giftBatchPostSeconds.observe).toHaveBeenCalledWith(
      { outcome: "failure" },
      expect.any(Number),
    );
    expect(metrics.giftBatchPostSeconds.observe).not.toHaveBeenCalledWith(
      { outcome: "success" },
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

    actual.metrics.giftBufferWaitSeconds.observe({ attempt: "first" }, 0.2);
    actual.metrics.giftBufferWaitSeconds.observe({ attempt: "retried" }, 0.3);
    const waitText = await actual.metricsRegistry.getSingleMetricAsString(
      "flylive_gift_buffer_wait_seconds",
    );
    expect(waitText).toContain("# TYPE flylive_gift_buffer_wait_seconds histogram");
    expect(waitText).toContain('attempt="first"');
    expect(waitText).toContain('attempt="retried"');
    for (const bucket of [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5]) {
      expect(waitText).toContain(`le="${bucket}"`);
    }

    actual.metrics.giftBatchPostSeconds.observe({ outcome: "success" }, 0.3);
    actual.metrics.giftBatchPostSeconds.observe({ outcome: "failure" }, 0.4);
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
    mockRedis.eval.mockResolvedValue([giftJson]);
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
    mockRedis.eval.mockResolvedValue([giftJson]);
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
    mockRedis.eval.mockResolvedValue([giftJson]);
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
    mockRedis.eval.mockResolvedValue([giftJson]);
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
    mockRedis.eval.mockResolvedValue([giftJson]);
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("Network error"));

    await buffer.stop();

    const pipeline = mockRedis._pipeline;
    expect(pipeline.rpush).toHaveBeenCalledWith(
      "gifts:dead_letter",
      expect.any(String),
    );
    // GF-006: Verify LTRIM is called to cap dead-letter queue
    expect(pipeline.ltrim).toHaveBeenCalledWith(
      "gifts:dead_letter",
      -10_000,
      -1,
    );
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
    mockRedis.eval.mockResolvedValue([corruptedEntry, validJson]);

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
    mockRedis.eval.mockResolvedValue(["{corrupt1", "{corrupt2"]);

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
    mockRedis.eval.mockResolvedValue([]); // empty queue for first 9 flushes
    buffer.start();
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    // 10th flush: has data
    mockRedis.eval.mockResolvedValue([giftJson]);
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
    // (First call = in-flight, second = final flush during stop.)
    expect(mockRedis.eval).toHaveBeenCalledTimes(2);
  });
});

// ─── Redis degradation instrumentation (platform-security 07) ───────
//
// pendingCount() was the epic's one FULLY silent degradation path: it caught
// a Redis error, emitted neither log nor metric, and returned -1. The sentinel
// is load-bearing (callers distinguish "unknown" from "zero"), so these tests
// pin that it is unchanged — the ticket adds observability, never behaviour.

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
