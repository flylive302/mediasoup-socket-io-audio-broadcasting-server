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

import { UserRoomRepository } from "@src/integrations/laravel/user-room.repository.js";

// Helper: create a mock Redis
function createMockRedis() {
  return {
    setex: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe("UserRoomRepository (RL-015)", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let logger: ReturnType<typeof createMockLogger>;
  let repo: UserRoomRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    logger = createMockLogger();
    repo = new UserRoomRepository(redis, logger);
  });

  // ─── setUserRoom ──────────────────────────────────────────────

  describe("setUserRoom", () => {
    it("stores room with 24h TTL", async () => {
      const result = await repo.setUserRoom(42, "room-99");

      expect(result).toBe(true);
      expect(redis.setex).toHaveBeenCalledWith(
        "user:42:room",
        86400,
        "room-99",
      );
    });

    it("returns false on Redis error", async () => {
      redis.setex.mockRejectedValue(new Error("Redis down"));

      const result = await repo.setUserRoom(42, "room-99");

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ─── clearUserRoom ────────────────────────────────────────────

  describe("clearUserRoom", () => {
    it("deletes the user room key", async () => {
      const result = await repo.clearUserRoom(42);

      expect(result).toBe(true);
      expect(redis.del).toHaveBeenCalledWith("user:42:room");
    });

    it("returns false on Redis error", async () => {
      redis.del.mockRejectedValue(new Error("Redis down"));

      const result = await repo.clearUserRoom(42);

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ─── getUserRoom ──────────────────────────────────────────────

  describe("getUserRoom", () => {
    it("returns null when user is not in any room", async () => {
      redis.get.mockResolvedValue(null);

      const result = await repo.getUserRoom(42);

      expect(result).toBeNull();
      expect(redis.get).toHaveBeenCalledWith("user:42:room");
    });

    it("returns room ID when user is in a room", async () => {
      redis.get.mockResolvedValue("room-55");

      const result = await repo.getUserRoom(42);

      expect(result).toBe("room-55");
    });

    it("returns null on Redis error", async () => {
      redis.get.mockRejectedValue(new Error("Redis down"));

      const result = await repo.getUserRoom(42);

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
