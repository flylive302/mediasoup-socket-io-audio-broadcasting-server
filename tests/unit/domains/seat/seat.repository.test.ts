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
  const redis = {
    defineCommand: vi.fn(),
    // Custom Lua commands (registered via defineCommand, called directly)
    seatTake: vi.fn(),
    seatLeave: vi.fn(),
    seatAssign: vi.fn(),
    seatSetMute: vi.fn(),
    seatLock: vi.fn(),
    scan: vi.fn(),
    pipeline: vi.fn().mockReturnValue({
      del: vi.fn().mockReturnThis(),
      setex: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    hgetall: vi.fn().mockResolvedValue({}),
    hget: vi.fn().mockResolvedValue(null),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    sismember: vi.fn().mockResolvedValue(0),
    setex: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return redis;
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

  // ─── Constructor (defineCommand registration) ──────────────────

  describe("constructor", () => {
    it("registers all Lua scripts via defineCommand", () => {
      expect(redis.defineCommand).toHaveBeenCalledWith("seatTake", expect.objectContaining({ numberOfKeys: 2 }));
      expect(redis.defineCommand).toHaveBeenCalledWith("seatLeave", expect.objectContaining({ numberOfKeys: 1 }));
      expect(redis.defineCommand).toHaveBeenCalledWith("seatAssign", expect.objectContaining({ numberOfKeys: 2 }));
      expect(redis.defineCommand).toHaveBeenCalledWith("seatSetMute", expect.objectContaining({ numberOfKeys: 1 }));
      expect(redis.defineCommand).toHaveBeenCalledWith("seatLock", expect.objectContaining({ numberOfKeys: 2 }));
      expect(redis.defineCommand).toHaveBeenCalledTimes(5);
    });
  });

  // ─── takeSeat (Lua atomicity) ─────────────────────────────────

  describe("takeSeat", () => {
    it("returns success when Lua script succeeds", async () => {
      redis.seatTake.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 3 }),
      );

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seatIndex).toBe(3);
      }
    });

    it("passes correct keys and args to custom command", async () => {
      redis.seatTake.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 3 }),
      );

      await repo.takeSeat("room1", "user42", 3, 15);

      expect(redis.seatTake).toHaveBeenCalledWith(
        "room:room1:seats",        // KEYS[1]
        "room:room1:locked_seats", // KEYS[2]
        "3",                       // ARGV[1] seatIndex
        "user42",                  // ARGV[2] userId
        "15",                      // ARGV[3] seatCount
      );
    });

    it("maps SEAT_LOCKED error from Lua", async () => {
      redis.seatTake.mockResolvedValue(
        JSON.stringify({ success: false, error: "SEAT_LOCKED" }),
      );

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("locked");
      }
    });

    it("maps SEAT_TAKEN error from Lua", async () => {
      redis.seatTake.mockResolvedValue(
        JSON.stringify({ success: false, error: "SEAT_TAKEN" }),
      );

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("taken");
      }
    });

    it("returns internal error on Redis failure", async () => {
      redis.seatTake.mockRejectedValue(new Error("Connection refused"));

      const result = await repo.takeSeat("room1", "user42", 3, 15);

      expect(result.success).toBe(false);
    });
  });

  // ─── leaveSeat (Lua) ──────────────────────────────────────────

  describe("leaveSeat", () => {
    it("returns success with freed seatIndex", async () => {
      redis.seatLeave.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 5 }),
      );

      const result = await repo.leaveSeat("room1", "user42");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seatIndex).toBe(5);
      }
    });

    it("returns NOT_SEATED when user has no seat", async () => {
      redis.seatLeave.mockResolvedValue(
        JSON.stringify({ success: false, error: "NOT_SEATED" }),
      );

      const result = await repo.leaveSeat("room1", "user42");

      expect(result.success).toBe(false);
    });
  });

  // ─── BL-003: setMute (atomic Lua) ─────────────────────────────

  describe("setMute (BL-003: atomic)", () => {
    it("returns true when Lua script updates mute state", async () => {
      redis.seatSetMute.mockResolvedValue(1);

      const result = await repo.setMute("room1", 3, true);

      expect(result).toBe(true);
      expect(redis.seatSetMute).toHaveBeenCalledWith(
        "room:room1:seats", // KEYS[1]
        "3",                // seatIndex
        "true",             // muted
      );
    });

    it("returns false when seat doesn't exist", async () => {
      redis.seatSetMute.mockResolvedValue(0);

      const result = await repo.setMute("room1", 99, true);

      expect(result).toBe(false);
    });

    it("returns false on Redis error", async () => {
      redis.seatSetMute.mockRejectedValue(new Error("Redis error"));

      const result = await repo.setMute("room1", 3, true);

      expect(result).toBe(false);
    });
  });

  // ─── BL-009: clearRoom ────────────────────────────────────────

  describe("clearRoom (BL-009)", () => {
    it("deletes seats hash, locked set, invite and reverse index keys via pipeline", async () => {
      // SCAN returns invite keys and user reverse index keys
      redis.scan
        .mockResolvedValueOnce(["0", [
          "room:room1:invite:0",
          "room:room1:invite:3",
          "room:room1:invite:user:user42",
        ]]);

      const mockPipeline = {
        del: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      redis.pipeline.mockReturnValue(mockPipeline);

      await repo.clearRoom("room1");

      // Should delete: seats hash, locked set, 2 invite keys, 1 user key = 5 del calls
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:seats");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:locked_seats");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:0");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:3");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:user:user42");
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
      redis.seatAssign.mockResolvedValue(
        JSON.stringify({ success: true, seatIndex: 2 }),
      );

      const result = await repo.assignSeat("room1", "user42", 2, 15);

      expect(result.success).toBe(true);
    });

    it("maps SEAT_INVALID error", async () => {
      redis.seatAssign.mockResolvedValue(
        JSON.stringify({ success: false, error: "SEAT_INVALID" }),
      );

      const result = await repo.assignSeat("room1", "user42", 99, 15);

      expect(result.success).toBe(false);
    });
  });

  // ─── Invite Management (reverse index) ────────────────────────

  describe("createInvite", () => {
    it("writes both invite data and reverse index via pipeline", async () => {
      const mockPipeline = {
        setex: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      redis.pipeline.mockReturnValue(mockPipeline);

      const result = await repo.createInvite("room1", 3, "user42", "owner1", 60);

      expect(result).toBe(true);
      expect(mockPipeline.setex).toHaveBeenCalledWith(
        "room:room1:invite:3",
        60,
        expect.stringContaining("user42"),
      );
      expect(mockPipeline.setex).toHaveBeenCalledWith(
        "room:room1:invite:user:user42",
        60,
        "3",
      );
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it("returns false on Redis error", async () => {
      redis.pipeline.mockReturnValue({
        setex: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error("fail")),
      });

      const result = await repo.createInvite("room1", 3, "user42", "owner1", 60);

      expect(result).toBe(false);
    });
  });

  describe("deleteInvite", () => {
    it("deletes both invite data and reverse index via pipeline", async () => {
      const invite = JSON.stringify({
        targetUserId: "user42",
        invitedBy: "owner1",
        seatIndex: 3,
        createdAt: Date.now(),
      });
      redis.get.mockResolvedValue(invite);

      const mockPipeline = {
        del: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      redis.pipeline.mockReturnValue(mockPipeline);

      const result = await repo.deleteInvite("room1", 3);

      expect(result).toBe(true);
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:3");
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:user:user42");
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it("only deletes invite key when data is missing", async () => {
      redis.get.mockResolvedValue(null);

      const mockPipeline = {
        del: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      redis.pipeline.mockReturnValue(mockPipeline);

      const result = await repo.deleteInvite("room1", 3);

      expect(result).toBe(true);
      expect(mockPipeline.del).toHaveBeenCalledTimes(1);
      expect(mockPipeline.del).toHaveBeenCalledWith("room:room1:invite:3");
    });
  });

  describe("getInviteByUser", () => {
    it("returns invite via O(1) reverse index lookup", async () => {
      // Reverse index returns seatIndex "5"
      redis.get
        .mockResolvedValueOnce("5")
        // getInvite reads the actual invite data
        .mockResolvedValueOnce(JSON.stringify({
          targetUserId: "user42",
          invitedBy: "owner1",
          seatIndex: 5,
          createdAt: Date.now(),
        }));

      const result = await repo.getInviteByUser("room1", "user42");

      expect(result).not.toBeNull();
      expect(result!.seatIndex).toBe(5);
      expect(result!.invite.targetUserId).toBe("user42");
      // Verify it used the reverse index key
      expect(redis.get).toHaveBeenCalledWith("room:room1:invite:user:user42");
    });

    it("returns null when no reverse index exists", async () => {
      redis.get.mockResolvedValue(null);

      const result = await repo.getInviteByUser("room1", "user42");

      expect(result).toBeNull();
    });

    it("returns null when reverse index exists but invite data is gone (TTL race)", async () => {
      redis.get
        .mockResolvedValueOnce("5")  // reverse index
        .mockResolvedValueOnce(null); // invite data expired

      const result = await repo.getInviteByUser("room1", "user42");

      expect(result).toBeNull();
    });

    it("returns null on Redis error", async () => {
      redis.get.mockRejectedValue(new Error("Connection lost"));

      const result = await repo.getInviteByUser("room1", "user42");

      expect(result).toBeNull();
    });
  });
});
