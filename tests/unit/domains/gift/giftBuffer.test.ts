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
    GIFT_MAX_RETRIES: 3,
  },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftBatchSize: { observe: vi.fn() },
    giftsProcessed: { inc: vi.fn() },
    giftDeadLetterSize: { set: vi.fn() },
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
    eval: vi.fn().mockResolvedValue(1),
    lrange: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
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
    recipient_id: 2,
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
      recipient_id: 2,
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

  it("skips processing when queue is empty (rename returns 0)", async () => {
    mockRedis.eval.mockResolvedValue(0);

    // Trigger flush via stop()
    await buffer.stop();

    expect(mockRedis.eval).toHaveBeenCalled();
    expect(mockRedis.lrange).not.toHaveBeenCalled();
    expect(mockLaravel.processGiftBatch).not.toHaveBeenCalled();
  });

  // ─── flush: happy path ────────────────────────────────────────────

  it("processes batch through Laravel and deletes processing key on success", async () => {
    const giftJson = makeGiftJSON();
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([giftJson]);

    await buffer.stop();

    expect(mockLaravel.processGiftBatch).toHaveBeenCalledWith([
      JSON.parse(giftJson),
    ]);
    expect(mockRedis.del).toHaveBeenCalled(); // Delete processing key
    expect(metrics.giftBatchSize.observe).toHaveBeenCalledWith(1);
    expect(metrics.giftsProcessed.inc).toHaveBeenCalledWith(
      { status: "success" },
      1,
    );
  });

  // ─── flush: Laravel failures ──────────────────────────────────────

  it("emits gift:error for Laravel-reported failures", async () => {
    const giftJson = makeGiftJSON();
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([giftJson]);
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
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([giftJson]);
    mockLaravel.processGiftBatch.mockRejectedValue(new Error("Network error"));

    await buffer.stop();

    const pipeline = mockRedis._pipeline;
    expect(pipeline.rpush).toHaveBeenCalledWith(
      "gifts:pending",
      expect.stringContaining('"retryCount":1'),
    );
    expect(pipeline.del).toHaveBeenCalled(); // Delete processing key
    expect(pipeline.exec).toHaveBeenCalled();
  });

  // ─── flush: max retries → dead-letter ─────────────────────────────

  it("moves to dead-letter queue when retryCount exceeds max", async () => {
    const giftJson = makeGiftJSON({ retryCount: 3 });
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([giftJson]);
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
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([corruptedEntry, validJson]);

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

  it("cleans up processing key when all items are corrupted (GF-003)", async () => {
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue(["{corrupt1", "{corrupt2"]);

    await buffer.stop();

    // Both entries go to dead-letter
    expect(mockRedis.rpush).toHaveBeenCalledTimes(2);
    // Laravel should NOT be called
    expect(mockLaravel.processGiftBatch).not.toHaveBeenCalled();
    // Processing key should still be cleaned up
    expect(mockRedis.del).toHaveBeenCalled();
  });

  // ─── GF-006 + GF-014: dead-letter queue size monitoring (sampled) ──

  it("reports dead-letter queue size metric on 10th flush (GF-006, GF-014)", async () => {
    const giftJson = makeGiftJSON();
    mockRedis.llen.mockResolvedValue(42);

    // GF-014: DLQ size is sampled every 10th flush.
    // Trigger 9 empty flushes via start() + advanceTimersByTime, then stop() for the 10th.
    mockRedis.eval.mockResolvedValue(0); // empty queue for first 9 flushes
    buffer.start();
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    // 10th flush: has data
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([giftJson]);
    await buffer.stop();

    expect(mockRedis.llen).toHaveBeenCalledWith("gifts:dead_letter");
    expect(metrics.giftDeadLetterSize.set).toHaveBeenCalledWith(42);
  });

  // ─── GF-007: instance-unique processing key ───────────────────────

  it("includes process.pid in processing key (GF-007)", async () => {
    mockRedis.eval.mockResolvedValue(0); // Empty queue

    await buffer.stop();

    const evalCall = mockRedis.eval.mock.calls[0];
    // eval(lua, 2, QUEUE_KEY, processingKey) → index 3 is the processing key
    const processingKey = evalCall[3] as string;
    expect(processingKey).toContain(`:${process.pid}:`);
  });
});
