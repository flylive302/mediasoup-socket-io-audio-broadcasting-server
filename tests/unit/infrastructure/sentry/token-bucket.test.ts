import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tokenBucket } from "@src/infrastructure/sentry/token-bucket.js";

describe("tokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts full", () => {
    const bucket = tokenBucket({ capacity: 3, refillPerHour: 30 });
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
  });

  it("drains to exactly capacity successes then fails", () => {
    const bucket = tokenBucket({ capacity: 5, refillPerHour: 30 });
    for (let i = 0; i < 5; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it("refills over time", () => {
    // 3600 tokens/hour == 1 token/second.
    const bucket = tokenBucket({ capacity: 5, refillPerHour: 3_600 });
    for (let i = 0; i < 5; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);

    // 2s elapsed -> 2 tokens refilled.
    vi.setSystemTime(2_000);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it("clamps refill at capacity", () => {
    const bucket = tokenBucket({ capacity: 5, refillPerHour: 3_600 });
    // Drain one token, then let a huge amount of time pass.
    expect(bucket.take()).toBe(true);
    vi.setSystemTime(1_000 * 60 * 60 * 24); // 1 day later

    // Bucket should be clamped at capacity (5), not overflowed.
    for (let i = 0; i < 5; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it("does not grant tokens when the clock goes backwards", () => {
    const bucket = tokenBucket({ capacity: 2, refillPerHour: 3_600 });
    vi.setSystemTime(10_000);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    // Clock jumps backwards.
    vi.setSystemTime(1_000);
    expect(bucket.take()).toBe(false);
  });

  it("capacity 0 always drops", () => {
    const bucket = tokenBucket({ capacity: 0, refillPerHour: 30 });
    expect(bucket.take()).toBe(false);
    vi.setSystemTime(1_000 * 60 * 60);
    expect(bucket.take()).toBe(false);
  });

  it("refillPerHour 0 never refills", () => {
    const bucket = tokenBucket({ capacity: 2, refillPerHour: 0 });
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    vi.setSystemTime(1_000 * 60 * 60 * 24); // 1 day later
    expect(bucket.take()).toBe(false);
  });
});
