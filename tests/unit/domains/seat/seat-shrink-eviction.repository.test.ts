/**
 * Unit tests for SeatRepository.evictSeatsAboveCount (room-seat-caps/02).
 * Same fully-mocked convention as seat-retention.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SeatRepository } from "@src/domains/seat/seat.repository.js";
import { TAKE_SEAT_SCRIPT } from "@src/domains/seat/seat.lua-scripts.js";

function createMockRedis() {
  return {
    defineCommand: vi.fn(),
    seatEvictShrink: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("SeatRepository.evictSeatsAboveCount", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let repo: SeatRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    repo = new SeatRepository(redis);
  });

  it("registers the seatEvictShrink command with a single Redis key", () => {
    expect(redis.defineCommand).toHaveBeenCalledWith(
      "seatEvictShrink",
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it("maps {index,userId} pairs from the Lua array", async () => {
    redis.seatEvictShrink.mockResolvedValue(
      JSON.stringify([[12, 55], [13, 66]]),
    );
    expect(await repo.evictSeatsAboveCount("r1", 10)).toEqual([
      { seatIndex: 12, userId: 55 },
      { seatIndex: 13, userId: 66 },
    ]);
  });

  it("returns [] when nothing was evicted (cjson encodes an empty table as {})", async () => {
    redis.seatEvictShrink.mockResolvedValue("{}");
    expect(await repo.evictSeatsAboveCount("r1", 10)).toEqual([]);
  });

  it("returns [] (never throws) on a Redis error", async () => {
    redis.seatEvictShrink.mockRejectedValue(new Error("boom"));
    expect(await repo.evictSeatsAboveCount("r1", 10)).toEqual([]);
  });

  it("passes the room's seats key, reverse-index prefix, and new seat count", async () => {
    redis.seatEvictShrink.mockResolvedValue("{}");
    await repo.evictSeatsAboveCount("r1", 10);
    expect(redis.seatEvictShrink).toHaveBeenCalledWith(
      "room:r1:seats",
      "room:r1:seat:user:",
      "10",
    );
  });
});

// ─── Concurrent take-seat bound (room-seat-caps/02 AC — partial) ───────────
// TAKE_SEAT_SCRIPT bounds-checks seatIndex against a `seatCount` ARGV the
// take-seat HANDLER reads from RoomState on a prior round-trip, not a value
// read inside this script's own Lua execution. Once a handler has picked up
// the NEW (lower) seatCount, this guard correctly rejects any index >= it.
// It does NOT close the narrow window where a handler already read the OLD
// (higher) seatCount just before a shrink lands — that take can still HSET a
// now-out-of-range index after SHRINK_EVICT_SCRIPT's scan has already run.
// See seat-shrink-eviction.ts's module doc for the full analysis; closing
// this fully would require seatCount to be read in-Lua from a Redis key the
// shrink updates atomically, which is out of scope for this slice.
describe("TAKE_SEAT_SCRIPT bounds guard (room-seat-caps/02 — post-sync takes only)", () => {
  it("rejects any seatIndex >= the seatCount ARGV passed by the caller", () => {
    expect(TAKE_SEAT_SCRIPT).toContain(
      "if seatIndex < 0 or seatIndex >= seatCount then",
    );
    expect(TAKE_SEAT_SCRIPT).toContain('error = "SEAT_INVALID"');
  });
});
