import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SeatRepository } from "@src/domains/seat/seat.repository.js";

// ─── Mock Redis ─────────────────────────────────────────────────────

function createMockRedis() {
  return {
    eval: vi.fn(),
    scan: vi.fn(),
    pipeline: vi.fn().mockReturnValue({
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    hgetall: vi.fn().mockResolvedValue({}),
    hget: vi.fn().mockResolvedValue(null),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    setex: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("SeatRepository", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let repo: SeatRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    repo = new SeatRepository(redis);
  });

  // ─── takeSeat (Lua atomicity) ──────────────────────────────────

  describe("takeSeat", () => {
    it("returns success when Lua script succeeds", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 3 }),
      );

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seatIndex).toBe(3);
      }
    });

    it("passes correct keys and args to Lua script", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 3 }),
      );

      await repo.takeSeat("room1", "user42", 3, 15);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), // Lua script
        2,                  // 2 keys
        "room:room1:seats", // KEYS[1]
        "room:room1:locked_seats", // KEYS[2]
        "3",                // ARGV[1] seatIndex
        "user42",           // ARGV[2] userId
        "15",               // ARGV[3] seatCount
      );
    });

    it("maps SEAT_LOCKED error from Lua", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: false, error: "SEAT_LOCKED" }),
      );

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("locked");
      }
    });

    it("maps SEAT_TAKEN error from Lua", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: false, error: "SEAT_TAKEN" }),
      );

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("taken");
      }
    });

    it("returns internal error on Redis failure", async () => {
      redis.eval.mockRejectedValue(new Error("Connection refused"));

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(false);
    });
  });

  // ─── leaveSeat (Lua) ──────────────────────────────────────────

  describe("leaveSeat", () => {
    it("returns success with freed seatIndex", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 5 }),
      );

      const result = await repo.leaveSeat("room1", "user42");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seatIndex).toBe(5);
      }
    });

    it("returns NOT_SEATED when user has no seat", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: false, error: "NOT_SEATED" }),
      );

      const result = await repo.leaveSeat("room1", "user42");

      expect(result.success).toBe(false);
    });
  });

  // ─── BL-003: setMute (atomic Lua) ─────────────────────────────

  describe("setMute (BL-003: atomic)", () => {
    it("returns true when Lua script updates mute state", async () => {
      redis.eval.mockResolvedValue(1);

      const result = await repo.setMute("room1", 3, true);

      expect(result).toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("HGET"), // Lua script contains HGET
        1,                  // 1 key
        "room:room1:seats", // KEYS[1]
        "3",                // seatIndex
        "true",             // muted
      );
    });

    it("returns false when seat doesn't exist", async () => {
      redis.eval.mockResolvedValue(0);

      const result = await repo.setMute("room1", 99, true);

      expect(result).toBe(false);
    });

    it("returns false on Redis error", async () => {
      redis.eval.mockRejectedValue(new Error("Redis error"));

      const result = await repo.setMute("room1", 3, true);

      expect(result).toBe(false);
    });
  });

  // ─── BL-009: clearRoom ────────────────────────────────────────

  describe("clearRoom (BL-009)", () => {
    it("deletes seats hash, locked set, and invite keys via pipeline", async () => {
      // SCAN returns invite keys then terminates
      redis.scan
        .mockResolvedValueOnce(["0", ["room:room1:invite:0", "room:room1:invite:3"]])

      const mockPipeline = {
        del: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      redis.pipeline.mockReturnValue(mockPipeline);

      await repo.clearRoom("room1");

      // Should delete: seats hash, locked set, and 2 invite keys = 4 del calls
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:seats");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:locked_seats");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:0");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:3");
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it("handles empty invite keys gracefully", async () => {
      redis.scan.mockResolvedValueOnce(["0", []]);

      const mockPipeline = {
        del: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      redis.pipeline.mockReturnValue(mockPipeline);

      await repo.clearRoom("room1");

      // Only seats hash + locked set = 2 del calls
      expect(mockPipeline.del).toHaveBeenCalledTimes(2);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it("does not throw on Redis error", async () => {
      redis.scan.mockRejectedValue(new Error("Connection lost"));

      // Should not throw
      await expect(repo.clearRoom("room1")).resolves.toBeUndefined();
    });
  });

  // ─── assignSeat (Lua) ─────────────────────────────────────────

  describe("assignSeat", () => {
    it("returns success when assigning user to seat", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 2 }),
      );

      const result = await repo.assignSeat("room1", "user42", 2, 15);

      expect(result.success).toBe(true);
    });

    it("maps SEAT_INVALID error", async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ success: false, error: "SEAT_INVALID" }),
      );

      const result = await repo.assignSeat("room1", "user42", 99, 15);

      expect(result.success).toBe(false);
    });
  });
});
