import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Server } from "socket.io";

let tickMs = 100;

vi.mock("@src/domains/gift/flags.js", () => ({
  giftRoomTickMs: () => tickMs,
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftBatchItems: { observe: vi.fn() },
    giftBatchesTotal: { inc: vi.fn() },
    giftBatchSpillTotal: { inc: vi.fn() },
    giftBatchRelayCallsTotal: { inc: vi.fn() },
  },
}));

import { metrics } from "@src/infrastructure/metrics.js";
import {
  initRoomTicker,
  resetRoomTickerForTests,
  enqueueGift,
  enqueueLucky,
  flushAllRooms,
  MAX_ITEMS_PER_BATCH,
} from "@src/domains/gift/roomTicker.js";

function createMockIo() {
  const emitFn = vi.fn();
  const localEmitFn = vi.fn();
  const io = {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    local: { to: vi.fn().mockReturnValue({ emit: localEmitFn }) },
    sockets: { adapter: { rooms: new Map() } },
  };
  return { io: io as unknown as Server, emitFn, localEmitFn };
}

function baseItem(overrides: Partial<Parameters<typeof enqueueGift>[1]> = {}) {
  return {
    senderId: 1,
    giftId: 100,
    recipientIds: [2, 3],
    quantity: 1,
    transactionId: "tx-1",
    ...overrides,
  };
}

describe("roomTicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tickMs = 100;
    resetRoomTickerForTests();
  });

  afterEach(() => {
    resetRoomTickerForTests();
    vi.useRealTimers();
  });

  it("does not start a timer until a room becomes non-empty, and stops it once empty", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    expect(vi.getTimerCount()).toBe(0);

    enqueueGift("room-1", baseItem());
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(100);
    expect(emitFn).toHaveBeenCalledTimes(1);

    // Nothing enqueued since — the next tick finds the room empty and stops.
    vi.advanceTimersByTime(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("merges same sender+gift+sorted-recipients into one item with summed quantity and count", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    enqueueGift("room-1", baseItem({ quantity: 2, transactionId: "tx-1", recipientIds: [3, 2] }));
    enqueueGift("room-1", baseItem({ quantity: 5, transactionId: "tx-2", recipientIds: [2, 3] }));

    vi.advanceTimersByTime(100);

    expect(emitFn).toHaveBeenCalledTimes(1);
    const payload = emitFn.mock.calls[0]![1];
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      senderId: 1,
      giftId: 100,
      // recipientIds keep the FIRST-seen item's order — only the merge key
      // (mergeKey()) sorts them; the emitted item's own array is untouched.
      recipientIds: [3, 2],
      quantity: 7,
      count: 2,
      transactionIds: ["tx-1", "tx-2"],
    });
  });

  it("does not merge different senders/gifts/recipient-sets", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    enqueueGift("room-1", baseItem({ senderId: 1 }));
    enqueueGift("room-1", baseItem({ senderId: 2 }));
    enqueueGift("room-1", baseItem({ giftId: 200 }));
    enqueueGift("room-1", baseItem({ recipientIds: [4] }));

    vi.advanceTimersByTime(100);

    const payload = emitFn.mock.calls[0]![1];
    expect(payload.items).toHaveLength(4);
  });

  it("caps items per emit at 200 and spills the remainder to the next tick", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    for (let i = 0; i < 205; i++) {
      enqueueGift("room-1", baseItem({ giftId: i, transactionId: `tx-${i}` }));
    }

    vi.advanceTimersByTime(100);
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn.mock.calls[0]![1].items).toHaveLength(MAX_ITEMS_PER_BATCH);
    expect(metrics.giftBatchSpillTotal.inc).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(emitFn).toHaveBeenCalledTimes(2);
    expect(emitFn.mock.calls[1]![1].items).toHaveLength(5);
    // Second tick's leftover (5 items) doesn't spill again.
    expect(metrics.giftBatchSpillTotal.inc).toHaveBeenCalledTimes(1);
  });

  it("increments seq per emit, per room", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    enqueueGift("room-1", baseItem());
    vi.advanceTimersByTime(100);
    expect(emitFn.mock.calls[0]![1].seq).toBe(1);

    enqueueGift("room-1", baseItem({ transactionId: "tx-2" }));
    vi.advanceTimersByTime(100);
    expect(emitFn.mock.calls[1]![1].seq).toBe(2);
  });

  it("folds lucky payloads into the next tick without merging or capping them", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    enqueueLucky("room-1", { winnerId: 9, prize: "a" });
    enqueueLucky("room-1", { winnerId: 9, prize: "a" }); // identical payload, still both kept
    enqueueLucky("room-1", { winnerId: 10, prize: "b" });

    vi.advanceTimersByTime(100);

    const payload = emitFn.mock.calls[0]![1];
    expect(payload.lucky).toHaveLength(3);
    expect(payload.items).toHaveLength(0);
  });

  it("flushAllRooms drains every room synchronously, including spilled remainder, and stops timers", () => {
    const { io, emitFn } = createMockIo();
    initRoomTicker(io, { cascadeRelay: null });

    for (let i = 0; i < 205; i++) {
      enqueueGift("room-1", baseItem({ giftId: i, transactionId: `tx-a-${i}` }));
    }
    enqueueGift("room-2", baseItem({ transactionId: "tx-b" }));
    enqueueLucky("room-3", { winnerId: 1 });

    flushAllRooms();

    // room-1 needed two emits to drain 205 items (200 + 5).
    const room1Emits = emitFn.mock.calls.filter((c) => c[1].roomId === "room-1");
    expect(room1Emits).toHaveLength(2);
    expect(room1Emits[0]![1].items).toHaveLength(200);
    expect(room1Emits[1]![1].items).toHaveLength(5);

    const room2Emits = emitFn.mock.calls.filter((c) => c[1].roomId === "room-2");
    expect(room2Emits).toHaveLength(1);

    const room3Emits = emitFn.mock.calls.filter((c) => c[1].roomId === "room-3");
    expect(room3Emits).toHaveLength(1);
    expect(room3Emits[0]![1].lucky).toHaveLength(1);

    // Every room's timer is gone after drain — nothing left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("relays cross-region once per emitted batch when a cascadeRelay with remotes is wired", () => {
    const { io, localEmitFn } = createMockIo();
    const relayToRemote = vi.fn().mockResolvedValue(undefined);
    const cascadeRelay = { hasRemotes: () => true, relayToRemote } as unknown as Parameters<
      typeof initRoomTicker
    >[1]["cascadeRelay"];
    initRoomTicker(io, { cascadeRelay });

    enqueueGift("room-1", baseItem());
    vi.advanceTimersByTime(100);

    // With a cascadeRelay wired, room-emit's local-only-emit + HTTP-relay
    // split kicks in (see shared/room-emit.ts) — the adapter emit goes
    // through `.local.to()`, not the plain `.to()` path.
    expect(localEmitFn).toHaveBeenCalledTimes(1);
    expect(relayToRemote).toHaveBeenCalledTimes(1);
    expect(relayToRemote).toHaveBeenCalledWith("room-1", "gift:batch", expect.any(Object));
  });
});
