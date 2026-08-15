import { describe, it, expect } from "vitest";
import {
  createRejectionBreaker,
  isTransientRedisRejection,
} from "@src/infrastructure/rejection-breaker.js";

/**
 * aws-production/35 — MSAB crash-exits on Redis failover.
 * The failover-window burst of ioredis rejections must NOT trip the crash
 * threshold; genuinely unknown rejection storms still must. Written failing
 * against the pre-35 behavior (every rejection counted) first.
 */

const OPTS = { threshold: 5, windowMs: 30_000 };

// The exact shapes ioredis 5 rejects with during an ElastiCache failover.
const commandTimedOut = () => new Error("Command timed out");
const connectionClosed = () => new Error("Connection is closed.");
const maxRetries = () => {
  const err = new Error("Reached the max retries per request limit of 3 (default is 20).");
  err.name = "MaxRetriesPerRequestError";
  return err;
};

describe("isTransientRedisRejection", () => {
  it("classifies the three ioredis failover shapes as transient", () => {
    expect(isTransientRedisRejection(commandTimedOut())).toBe(true);
    expect(isTransientRedisRejection(connectionClosed())).toBe(true);
    expect(isTransientRedisRejection(maxRetries())).toBe(true);
  });

  it("does not classify unknown errors, non-errors, or near-miss messages", () => {
    expect(isTransientRedisRejection(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientRedisRejection(new TypeError("x is not a function"))).toBe(false);
    expect(isTransientRedisRejection("Command timed out")).toBe(false); // string, not Error
    expect(isTransientRedisRejection(new Error("Command timed out after retry"))).toBe(false);
    expect(isTransientRedisRejection(undefined)).toBe(false);
  });
});

describe("rejection breaker", () => {
  it("a Redis failover burst never crashes, regardless of volume", () => {
    // The observed incident: >5 command timeouts inside one window.
    const breaker = createRejectionBreaker(OPTS);
    for (let i = 0; i < 50; i++) {
      const verdict = breaker.record(commandTimedOut(), 1_000 + i * 100);
      expect(verdict.action).toBe("redis-transient");
    }
  });

  it("an unknown rejection storm still crash-exits at the threshold", () => {
    const breaker = createRejectionBreaker(OPTS);
    for (let i = 0; i < 4; i++) {
      expect(breaker.record(new Error(`boom ${i}`), 1_000 + i).action).toBe("count");
    }
    expect(breaker.record(new Error("boom 4"), 1_005).action).toBe("crash");
  });

  it("Redis-transient rejections do not pad the window toward an unknown-storm crash", () => {
    const breaker = createRejectionBreaker(OPTS);
    for (let i = 0; i < 4; i++) breaker.record(commandTimedOut(), 1_000 + i);
    // 4 transients recorded; a single unknown rejection must be count #1, not #5.
    expect(breaker.record(new Error("boom"), 1_010).action).toBe("count");
  });

  it("counts reset outside the sliding window", () => {
    const breaker = createRejectionBreaker(OPTS);
    for (let i = 0; i < 4; i++) breaker.record(new Error("boom"), 1_000 + i);
    // 31s later the window has drained; the 5th unknown rejection is count 1.
    const verdict = breaker.record(new Error("boom"), 32_500);
    expect(verdict.action).toBe("count");
    expect(verdict.count).toBe(1);
  });
});
