import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import { BLOCK_KEY, RoomBlockRepository } from "@src/domains/room/room-block.repository.js";

// Helper: create a mock Redis covering only what RoomBlockRepository touches.
function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-2),
  } as unknown as Redis & {
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    ttl: ReturnType<typeof vi.fn>;
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("RoomBlockRepository", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let logger: ReturnType<typeof createMockLogger>;
  let repo: RoomBlockRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    logger = createMockLogger();
    repo = new RoomBlockRepository(redis, logger);
  });

  // ─── BLOCK_KEY ──────────────────────────────────────────────

  describe("BLOCK_KEY", () => {
    // THE LITERAL KEY TEST. This pins the cross-service wire contract with
    // Laravel's block fanout (event-router writes it, room:join GATE reads
    // it) — assert the literal string, NOT a re-derivation via template
    // literal. A template-based assertion (`` `room:${roomId}:blocked:${userId}` ``)
    // would pass even if the contract itself silently changed, which is
    // exactly the class of bug msab-join-gates 02 was.
    it("produces the exact literal wire-contract string", () => {
      expect(BLOCK_KEY("7", 42)).toBe("room:7:blocked:42");
    });
  });

  // ─── writeBlock ─────────────────────────────────────────────

  describe("writeBlock", () => {
    it("calls redis.set with key, '1', EX and the ttl for a positive remainingSeconds", async () => {
      await repo.writeBlock("7", 42, 3600);

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 3600);
    });

    it("calls redis.set with just key and '1' (no TTL) when remainingSeconds is null — permanent block", async () => {
      await repo.writeBlock("7", 42, null);

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1");
    });

    it("calls redis.set with just key and '1' (no TTL) when remainingSeconds is undefined — permanent block", async () => {
      await repo.writeBlock("7", 42, undefined);

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1");
    });

    it("floors a fractional remainingSeconds", async () => {
      await repo.writeBlock("7", 42, 59.9);

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 59);
    });

    it("clamps a sub-1-second remainingSeconds up to a minimum ttl of 1", async () => {
      await repo.writeBlock("7", 42, 0.4);

      expect(redis.set).toHaveBeenCalledWith("room:7:blocked:42", "1", "EX", 1);
    });

    // Regression guard: writeBlock used to swallow the Redis error and
    // resolve, which made the caller's (event-router) reactError → Sentry
    // escalation unreachable dead code (msab-join-gates 02). It must reject.
    it("rejects when redis.set rejects", async () => {
      redis.set.mockRejectedValue(new Error("Redis down"));

      await expect(repo.writeBlock("7", 42, 3600)).rejects.toThrow("Redis down");
    });
  });

  // ─── deleteBlock ────────────────────────────────────────────

  describe("deleteBlock", () => {
    it("calls redis.del with the exact key", async () => {
      await repo.deleteBlock("7", 42);

      expect(redis.del).toHaveBeenCalledWith("room:7:blocked:42");
    });

    it("rejects when redis.del rejects", async () => {
      redis.del.mockRejectedValue(new Error("Redis down"));

      await expect(repo.deleteBlock("7", 42)).rejects.toThrow("Redis down");
    });
  });

  // ─── getStatus ──────────────────────────────────────────────

  describe("getStatus", () => {
    it("maps ttl -2 (key absent) to not blocked", async () => {
      redis.ttl.mockResolvedValue(-2);

      const status = await repo.getStatus("7", 42);

      expect(status).toEqual({ blocked: false, permanent: false, remainingSeconds: null });
    });

    it("maps ttl -1 (no expiry) to blocked + permanent", async () => {
      redis.ttl.mockResolvedValue(-1);

      const status = await repo.getStatus("7", 42);

      expect(status).toEqual({ blocked: true, permanent: true, remainingSeconds: null });
    });

    it("maps ttl 3600 to blocked, not permanent, with remainingSeconds 3600", async () => {
      redis.ttl.mockResolvedValue(3600);

      const status = await repo.getStatus("7", 42);

      expect(status).toEqual({ blocked: true, permanent: false, remainingSeconds: 3600 });
    });

    // Deliberate per ADR 0017: failing closed would lock every legitimate
    // joiner out of every room during a Redis blip, a far larger outage than
    // the moderation gap fail-open accepts. The roomBlockMirror failure
    // metric (not a thrown error) is the compensating control that keeps
    // this fail-open path from going unnoticed the way msab-join-gates 02 did.
    it("fails open (resolves not-blocked, does not reject) when redis.ttl rejects", async () => {
      redis.ttl.mockRejectedValue(new Error("Redis down"));

      await expect(repo.getStatus("7", 42)).resolves.toEqual({
        blocked: false,
        permanent: false,
        remainingSeconds: null,
      });
    });
  });
});
