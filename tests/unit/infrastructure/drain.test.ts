import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config
vi.mock("@src/config/index.js", () => ({
  config: {
    LARAVEL_INTERNAL_KEY: "test-key-123",
    NODE_ENV: "test",
  },
}));

// Mock logger
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  isDraining,
  isDrained,
  startDrain,
  resetDrain,
} from "@src/infrastructure/drain.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRoomManager(initialRoomCount = 0) {
  let roomCount = initialRoomCount;
  return {
    getRoomCount: vi.fn(() => roomCount),
    _setRoomCount(n: number) {
      roomCount = n;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Drain Mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDrain();
  });

  afterEach(() => {
    resetDrain();
    vi.useRealTimers();
  });

  describe("isDraining / isDrained", () => {
    it("returns false initially", () => {
      expect(isDraining()).toBe(false);
      expect(isDrained()).toBe(false);
    });

    it("isDraining returns true after startDrain", () => {
      const rm = createMockRoomManager(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any);
      expect(isDraining()).toBe(true);
    });

    it("does not start drain twice", () => {
      const rm = createMockRoomManager(5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any); // should warn, not throw
      expect(isDraining()).toBe(true);
    });
  });

  describe("drain completion", () => {
    it("completes when room count reaches 0 on poll", () => {
      const rm = createMockRoomManager(3);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any);

      expect(isDrained()).toBe(false);

      // Simulate rooms closing
      rm._setRoomCount(0);

      // Advance past poll interval (5s)
      vi.advanceTimersByTime(5_000);

      expect(isDrained()).toBe(true);
    });

    it("completes immediately if room count is already 0", () => {
      const rm = createMockRoomManager(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any);

      // First poll at 5s
      vi.advanceTimersByTime(5_000);

      expect(isDrained()).toBe(true);
    });

    it("calls onComplete callback when drained", () => {
      const rm = createMockRoomManager(1);
      const onComplete = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any, { onComplete });

      // Still has rooms
      vi.advanceTimersByTime(5_000);
      expect(onComplete).not.toHaveBeenCalled();

      // Rooms close
      rm._setRoomCount(0);
      vi.advanceTimersByTime(5_000);

      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("drain timeout", () => {
    it("force-completes after timeout", () => {
      const rm = createMockRoomManager(5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any, { timeoutMs: 10_000 });

      // Rooms never close
      vi.advanceTimersByTime(10_000);

      expect(isDrained()).toBe(true);
    });

    it("uses custom timeout", () => {
      const rm = createMockRoomManager(5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any, { timeoutMs: 3_000 });

      vi.advanceTimersByTime(3_000);
      expect(isDrained()).toBe(true);
    });
  });

  describe("resetDrain", () => {
    it("resets all state", () => {
      const rm = createMockRoomManager(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startDrain(rm as any);

      vi.advanceTimersByTime(5_000);
      expect(isDrained()).toBe(true);

      resetDrain();
      expect(isDraining()).toBe(false);
      expect(isDrained()).toBe(false);
    });
  });
});
