import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "@src/infrastructure/rateLimiter.js";
import { config } from "@src/config/index.js";
import type { Redis } from "ioredis";

// F-44: tests cover the sliding-window Lua script return contract and the
// configurable fail-policy on Redis errors. The Lua script is registered via
// defineCommand at construction and exposed on the redis instance as
// `rlSlidingWindow`; the test mocks both.

describe("RateLimiter (F-44 sliding-window)", () => {
  let rateLimiter: RateLimiter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      defineCommand: vi.fn(),
      rlSlidingWindow: vi.fn(),
    };
    rateLimiter = new RateLimiter(mockRedis as Redis);
  });

  it("registers the sliding-window Lua script at construction", () => {
    expect(mockRedis.defineCommand).toHaveBeenCalledWith(
      "rlSlidingWindow",
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it("allows when Lua returns 1 (under limit)", async () => {
    mockRedis.rlSlidingWindow.mockResolvedValue(1);
    const allowed = await rateLimiter.isAllowed("user:123", 10, 60);
    expect(allowed).toBe(true);
    expect(mockRedis.rlSlidingWindow).toHaveBeenCalledWith(
      1,
      "ratelimit:user:123",
      expect.any(String), // now ms
      "60000",            // windowMs
      "10",               // limit
      expect.stringMatching(/^\d+:/), // unique member `${now}:${uuid}`
    );
  });

  it("blocks when Lua returns 0 (at/over limit)", async () => {
    mockRedis.rlSlidingWindow.mockResolvedValue(0);
    const allowed = await rateLimiter.isAllowed("user:123", 10, 60);
    expect(allowed).toBe(false);
  });

  it("fails CLOSED on Redis error by default (RATE_LIMIT_FAIL_OPEN=false)", async () => {
    mockRedis.rlSlidingWindow.mockRejectedValue(new Error("redis down"));
    const allowed = await rateLimiter.isAllowed("user:123", 10, 60);
    expect(allowed).toBe(false);
  });

  it("fails OPEN on Redis error when RATE_LIMIT_FAIL_OPEN=true", async () => {
    const original = config.RATE_LIMIT_FAIL_OPEN;
    (config as { RATE_LIMIT_FAIL_OPEN: boolean }).RATE_LIMIT_FAIL_OPEN = true;
    try {
      mockRedis.rlSlidingWindow.mockRejectedValue(new Error("redis down"));
      const allowed = await rateLimiter.isAllowed("user:123", 10, 60);
      expect(allowed).toBe(true);
    } finally {
      (config as { RATE_LIMIT_FAIL_OPEN: boolean }).RATE_LIMIT_FAIL_OPEN = original;
    }
  });
});
