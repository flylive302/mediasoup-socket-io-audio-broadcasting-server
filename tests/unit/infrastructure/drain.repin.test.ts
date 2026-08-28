/**
 * aws-production/20 — drain moves rooms instead of waiting them out.
 *
 * Under affinity, startDrain runs a re-pin loop beside the existing
 * poll/timeout machinery: mark self draining in Laravel, pull bounded
 * batches until none of our rooms remain, progress stalls, or Laravel
 * keeps failing. The loop must never alter drain's honest outcome
 * semantics, and affinity-off drains must be byte-for-byte unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    LARAVEL_INTERNAL_KEY: "test-key-123",
    NODE_ENV: "test",
    AFFINITY_ENABLED: false,
  },
}));

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
  startDrain,
  resetDrain,
  getDrainReport,
  registerDrainRepinClient,
  REPIN_BATCH_SIZE,
  REPIN_MAX_CONSECUTIVE_FAILURES,
  type DrainRepinClient,
} from "@src/infrastructure/drain.js";

function createMockRoomManager(initialRoomCount = 0) {
  let roomCount = initialRoomCount;
  return {
    getRoomCount: vi.fn(() => roomCount),
    _setRoomCount(n: number) {
      roomCount = n;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Repin client whose batches are scripted; records every call. */
function createMockRepinClient(batches: Array<{ repinned: number; unplaced: number; remaining: number; held?: number } | null>) {
  let call = 0;
  const client: DrainRepinClient = {
    setInstanceDraining: vi.fn(async () => true),
    repinRooms: vi.fn(async () => {
      const batch = batches[Math.min(call, batches.length - 1)] ?? null;
      call++;
      return batch ? { held: 0, ...batch } : null;
    }),
  };
  return client;
}

describe("Drain re-pin loop (aws-production/20)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDrain();
    registerDrainRepinClient(null);
  });

  afterEach(() => {
    resetDrain();
    registerDrainRepinClient(null);
    vi.useRealTimers();
  });

  it("marks the instance draining and re-pins in bounded batches until none remain", async () => {
    const client = createMockRepinClient([
      { repinned: 25, unplaced: 0, remaining: 10 },
      { repinned: 10, unplaced: 0, remaining: 0 },
    ]);
    registerDrainRepinClient(client);

    startDrain(createMockRoomManager(3), {
      timeoutMs: 600_000,
      affinityEnabled: () => true,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.setInstanceDraining).toHaveBeenCalledWith(true);
    expect(client.repinRooms).toHaveBeenCalledTimes(2);
    expect(client.repinRooms).toHaveBeenCalledWith(REPIN_BATCH_SIZE);
  });

  it("the final report carries honest cumulative re-pin totals", async () => {
    const client = createMockRepinClient([
      { repinned: 25, unplaced: 0, remaining: 5 },
      { repinned: 5, unplaced: 0, remaining: 0 },
    ]);
    registerDrainRepinClient(client);

    const roomManager = createMockRoomManager(2);
    startDrain(roomManager, { timeoutMs: 600_000, affinityEnabled: () => true });
    await vi.advanceTimersByTimeAsync(4_000);

    roomManager._setRoomCount(0);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(getDrainReport()).toMatchObject({
      outcome: "all_rooms_closed",
      repin: { repinned: 30, unplaced: 0, remaining: 0, held: 0 },
    });
  });

  it("carries held from the last batch into the final repin summary", async () => {
    const client = createMockRepinClient([
      { repinned: 25, unplaced: 0, remaining: 5, held: 0 },
      { repinned: 5, unplaced: 0, remaining: 0, held: 3 },
    ]);
    registerDrainRepinClient(client);

    const roomManager = createMockRoomManager(2);
    startDrain(roomManager, { timeoutMs: 600_000, affinityEnabled: () => true });
    await vi.advanceTimersByTimeAsync(4_000);

    roomManager._setRoomCount(0);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(getDrainReport()).toMatchObject({
      outcome: "all_rooms_closed",
      repin: { repinned: 30, unplaced: 0, remaining: 0, held: 3 },
    });
  });

  it("stalls honestly when no healthy target exists — drain keeps waiting rooms out", async () => {
    const client = createMockRepinClient([
      { repinned: 0, unplaced: 4, remaining: 4 },
    ]);
    registerDrainRepinClient(client);

    const roomManager = createMockRoomManager(4);
    startDrain(roomManager, { timeoutMs: 60_000, affinityEnabled: () => true });
    await vi.advanceTimersByTimeAsync(5_000);

    // Loop stopped after the stalled batch — no hammering.
    expect(client.repinRooms).toHaveBeenCalledTimes(1);

    // Drain still force-completes honestly at the ceiling.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDrainReport()).toMatchObject({
      outcome: "timeout",
      roomsStillOpen: 4,
      repin: { repinned: 0, unplaced: 4, remaining: 4, held: 0 },
    });
  });

  it("gives up after repeated Laravel failures without touching drain semantics", async () => {
    const client = createMockRepinClient([null]);
    registerDrainRepinClient(client);

    const roomManager = createMockRoomManager(1);
    startDrain(roomManager, { timeoutMs: 60_000, affinityEnabled: () => true });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(client.repinRooms).toHaveBeenCalledTimes(REPIN_MAX_CONSECUTIVE_FAILURES);

    roomManager._setRoomCount(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getDrainReport()).toMatchObject({ outcome: "all_rooms_closed" });
  });

  it("with affinity off, drain never talks to Laravel and reports repin: null", async () => {
    const client = createMockRepinClient([{ repinned: 1, unplaced: 0, remaining: 0 }]);
    registerDrainRepinClient(client);

    const roomManager = createMockRoomManager(0);
    startDrain(roomManager, { timeoutMs: 60_000, affinityEnabled: () => false });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(client.setInstanceDraining).not.toHaveBeenCalled();
    expect(client.repinRooms).not.toHaveBeenCalled();
    expect(getDrainReport()).toMatchObject({
      outcome: "all_rooms_closed",
      repin: null,
    });
  });

  it("with no client registered, an affinity drain degrades to the wait-only path", async () => {
    const roomManager = createMockRoomManager(0);
    startDrain(roomManager, { timeoutMs: 60_000, affinityEnabled: () => true });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(getDrainReport()).toMatchObject({
      outcome: "all_rooms_closed",
      repin: null,
    });
  });
});
