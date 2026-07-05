import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SeatRepository } from "@src/domains/seat/seat.repository.js";
import {
  RESERVE_SEAT_SCRIPT,
  RECLAIM_SEAT_SCRIPT,
  SWEEP_EXPIRED_SEATS_SCRIPT,
} from "@src/domains/seat/seat.lua-scripts.js";

// ─── Mock Redis ─────────────────────────────────────────────────────
// Matches the fully-mocked convention in seat.repository.test.ts: the Lua
// commands are vi.fn()s whose return we set per-test to exercise the
// repository's parsing/mapping. The Lua *behaviour* is locked separately by the
// structural-invariant assertions below (the leave-seat.scan-fallback pattern).

function createMockRedis() {
  return {
    defineCommand: vi.fn(),
    seatReserve: vi.fn(),
    seatReclaim: vi.fn(),
    seatSweepExpired: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("SeatRepository — retention (realtime-22)", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let repo: SeatRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    repo = new SeatRepository(redis);
  });

  describe("reserveSeat", () => {
    it("returns the reserved indices on success", async () => {
      redis.seatReserve.mockResolvedValue(
        JSON.stringify({ success: true, reservedSeatIndices: [3] }),
      );
      expect(await repo.reserveSeat("r1", "100", 1_700_000_000_000)).toEqual([3]);
    });

    it("returns [] when the user held no seat", async () => {
      redis.seatReserve.mockResolvedValue(
        JSON.stringify({ success: false, error: "NOT_SEATED" }),
      );
      expect(await repo.reserveSeat("r1", "100", 1)).toEqual([]);
    });

    it("returns [] (never throws) on a Redis error", async () => {
      redis.seatReserve.mockRejectedValue(new Error("boom"));
      expect(await repo.reserveSeat("r1", "100", 1)).toEqual([]);
    });
  });

  describe("reclaimSeat", () => {
    it("parses a successful reclaim (index + mute restored)", async () => {
      redis.seatReclaim.mockResolvedValue(
        JSON.stringify({ reclaimed: true, seatIndex: 3, isMuted: true }),
      );
      expect(await repo.reclaimSeat("r1", "100", 1, 45_000)).toEqual({
        reclaimed: true,
        seatIndex: 3,
        isMuted: true,
      });
    });

    it("yields reclaimed:false when the slot is no longer the user's (no steal)", async () => {
      redis.seatReclaim.mockResolvedValue(JSON.stringify({ reclaimed: false }));
      expect(await repo.reclaimSeat("r1", "100", 1, 45_000)).toEqual({
        reclaimed: false,
      });
    });

    it("degrades to reclaimed:false (never throws) on a Redis error", async () => {
      redis.seatReclaim.mockRejectedValue(new Error("boom"));
      expect(await repo.reclaimSeat("r1", "100", 1, 45_000)).toEqual({
        reclaimed: false,
      });
    });
  });

  describe("sweepExpiredReservations", () => {
    it("maps {index,userId} pairs from the Lua array", async () => {
      redis.seatSweepExpired.mockResolvedValue(JSON.stringify([[3, 100], [5, 200]]));
      expect(await repo.sweepExpiredReservations("r1", 1, 45_000)).toEqual([
        { seatIndex: 3, userId: 100 },
        { seatIndex: 5, userId: 200 },
      ]);
    });

    it("returns [] for an empty sweep (cjson encodes an empty table as {})", async () => {
      redis.seatSweepExpired.mockResolvedValue("{}");
      expect(await repo.sweepExpiredReservations("r1", 1, 45_000)).toEqual([]);
    });

    it("returns [] (never throws) on a Redis error", async () => {
      redis.seatSweepExpired.mockRejectedValue(new Error("boom"));
      expect(await repo.sweepExpiredReservations("r1", 1, 45_000)).toEqual([]);
    });
  });
});

// ─── Lua structural invariants ──────────────────────────────────────
// Same approach as leave-seat.scan-fallback.test.ts: assert the load-bearing
// semantics of the scripts so an accidental revert of a race-safety guard fails
// CI even though the Lua does not execute in these unit tests.

describe("Seat retention Lua invariants (realtime-22)", () => {
  describe("RESERVE_SEAT_SCRIPT", () => {
    it("stamps a disconnectedAt marker without removing the occupant", () => {
      expect(RESERVE_SEAT_SCRIPT).toContain("data.disconnectedAt = now");
      expect(RESERVE_SEAT_SCRIPT).toContain("HSET");
      // It must NOT HDEL — the seat stays occupied through the grace window.
      expect(RESERVE_SEAT_SCRIPT).not.toContain("HDEL");
    });

    it("scans every seat the user holds (bounded HGETALL, mirrors leave)", () => {
      expect(RESERVE_SEAT_SCRIPT).toContain("HGETALL");
      expect(RESERVE_SEAT_SCRIPT).toMatch(/tostring\(data\.userId\) == tostring\(userId\)/);
    });
  });

  describe("RECLAIM_SEAT_SCRIPT", () => {
    it("only reclaims a slot that is STILL the user's (no double-occupancy steal)", () => {
      expect(RECLAIM_SEAT_SCRIPT).toMatch(/tostring\(data\.userId\) == tostring\(userId\)/);
    });

    it("only reclaims a live (non-expired) reservation within the grace window", () => {
      expect(RECLAIM_SEAT_SCRIPT).toContain("data.disconnectedAt ~= nil");
      expect(RECLAIM_SEAT_SCRIPT).toContain("(now - data.disconnectedAt) <= graceMs");
    });

    it("clears the marker and restores the reverse index on success", () => {
      expect(RECLAIM_SEAT_SCRIPT).toContain("data.disconnectedAt = nil");
      expect(RECLAIM_SEAT_SCRIPT).toMatch(/SET['"]?,\s*userSeatKey|SET', userSeatKey/);
      expect(RECLAIM_SEAT_SCRIPT).toContain("reclaimed = true");
    });

    it("defaults to not-reclaimed when no live reservation matches", () => {
      expect(RECLAIM_SEAT_SCRIPT).toContain("reclaimed = false");
    });
  });

  describe("SWEEP_EXPIRED_SEATS_SCRIPT", () => {
    it("clears ONLY reservations older than the grace window", () => {
      expect(SWEEP_EXPIRED_SEATS_SCRIPT).toContain("data.disconnectedAt ~= nil");
      expect(SWEEP_EXPIRED_SEATS_SCRIPT).toContain("(now - data.disconnectedAt) > graceMs");
    });

    it("HDELs the seat and drops the user's reverse index", () => {
      expect(SWEEP_EXPIRED_SEATS_SCRIPT).toContain("HDEL");
      expect(SWEEP_EXPIRED_SEATS_SCRIPT).toContain("userSeatPrefix");
      expect(SWEEP_EXPIRED_SEATS_SCRIPT).toContain("DEL");
    });

    it("returns {index,userId} pairs so the caller can broadcast per slot", () => {
      expect(SWEEP_EXPIRED_SEATS_SCRIPT).toMatch(/table\.insert\(cleared, \{ tonumber\(idx\), tonumber\(data\.userId\) \}\)/);
    });
  });
});
