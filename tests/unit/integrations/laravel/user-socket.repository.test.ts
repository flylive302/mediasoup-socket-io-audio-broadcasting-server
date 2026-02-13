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

import { UserSocketRepository } from "@src/integrations/laravel/user-socket.repository.js";

// Helper: create a mock Redis
function createMockRedis() {
  const multiChain = {
    sadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([[null, 1], [null, 1]]),
  };

  return {
    multi: vi.fn().mockReturnValue(multiChain),
    eval: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    _multiChain: multiChain,
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

describe("UserSocketRepository", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let logger: ReturnType<typeof createMockLogger>;
  let repo: UserSocketRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    logger = createMockLogger();
    repo = new UserSocketRepository(redis, logger);
  });

  // ─── registerSocket ─────────────────────────────────────────

  describe("registerSocket", () => {
    it("adds socket to user set and sets TTL via pipeline", async () => {
      const result = await repo.registerSocket(42, "socket-abc");

      expect(result).toBe(true);
      expect(redis.multi).toHaveBeenCalled();
      expect(redis._multiChain.sadd).toHaveBeenCalledWith("user:42:sockets", "socket-abc");
      expect(redis._multiChain.expire).toHaveBeenCalledWith("user:42:sockets", 86400);
      expect(redis._multiChain.exec).toHaveBeenCalled();
    });

    it("returns false on Redis error", async () => {
      redis._multiChain.exec.mockRejectedValue(new Error("Redis down"));

      const result = await repo.registerSocket(42, "socket-abc");

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ─── unregisterSocket ───────────────────────────────────────

  describe("unregisterSocket", () => {
    it("executes Lua script for atomic SREM + conditional DEL", async () => {
      const result = await repo.unregisterSocket(42, "socket-abc");

      expect(result).toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('srem'"),
        1,
        "user:42:sockets",
        "socket-abc",
      );
    });

    it("returns false on Redis error", async () => {
      redis.eval.mockRejectedValue(new Error("Redis down"));

      const result = await repo.unregisterSocket(42, "socket-abc");

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ─── getSocketIds ───────────────────────────────────────────

  describe("getSocketIds", () => {
    it("returns socket IDs for a user", async () => {
      redis.smembers.mockResolvedValue(["s1", "s2"]);

      const result = await repo.getSocketIds(42);

      expect(result).toEqual(["s1", "s2"]);
      expect(redis.smembers).toHaveBeenCalledWith("user:42:sockets");
    });

    it("returns empty array when no sockets exist", async () => {
      redis.smembers.mockResolvedValue([]);

      const result = await repo.getSocketIds(42);

      expect(result).toEqual([]);
    });

    it("returns empty array on Redis error", async () => {
      redis.smembers.mockRejectedValue(new Error("Redis down"));

      const result = await repo.getSocketIds(42);

      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
