/**
 * Unit tests for evictShrunkSeats (room-seat-caps/02 — Seat Eviction (shrink)).
 *
 * Scope: the EXECUTE+REACT sequence (producer close, room broadcast, targeted
 * emit) given a set of {seatIndex,userId} pairs returned by the atomic Lua
 * clear. The Lua script's own structural invariants are asserted separately
 * below (prior art: seat-retention.test.ts's Lua invariant suite).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { evictShrunkSeats } from "@src/domains/room/seat-shrink-eviction.js";
import { SHRINK_EVICT_SCRIPT } from "@src/domains/seat/seat.lua-scripts.js";

function makeIo() {
  const roomEmit = vi.fn();
  const targetedEmit = vi.fn();
  return {
    to: vi.fn((target: string | string[]) => {
      if (Array.isArray(target)) {
        return { emit: targetedEmit };
      }
      return { emit: roomEmit };
    }),
    roomEmit,
    targetedEmit,
  } as any;
}

function makeClientManager(overrides: {
  clientsInRoom?: any[];
  socketIdsByUser?: Record<number, string[]>;
} = {}) {
  return {
    getClientsInRoom: vi.fn(() => overrides.clientsInRoom ?? []),
    getSocketIdsByUserInRoom: vi.fn(
      (userId: number) => overrides.socketIdsByUser?.[userId] ?? [],
    ),
  } as any;
}

describe("evictShrunkSeats", () => {
  let io: ReturnType<typeof makeIo>;

  beforeEach(() => {
    io = makeIo();
  });

  it("no-ops when nothing was evicted (empty Lua result)", async () => {
    const seatRepository = { evictSeatsAboveCount: vi.fn().mockResolvedValue([]) } as any;
    const clientManager = makeClientManager();
    const getRoom = vi.fn();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(io.to).not.toHaveBeenCalled();
    expect(getRoom).not.toHaveBeenCalled();
  });

  it("closes the displaced user's audio producer (ownership-verified, mirrors seat:lock kick)", async () => {
    const producer = { closed: false, appData: { userId: 55 }, close: vi.fn() };
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const client = { userId: 55, producers: new Map([["audio", "prod-1"]]), isSpeaker: true };
    const clientManager = makeClientManager({ clientsInRoom: [client] });
    const getRoom = vi.fn(() => ({ getProducer: vi.fn(() => producer) }) as any);

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(producer.close).toHaveBeenCalledTimes(1);
    expect(client.producers.has("audio")).toBe(false);
    expect(client.isSpeaker).toBe(false);
  });

  it("skips producer close when ownership no longer matches (F-45 guard)", async () => {
    const producer = { closed: false, appData: { userId: 999 }, close: vi.fn() };
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const client = { userId: 55, producers: new Map([["audio", "prod-1"]]), isSpeaker: true };
    const clientManager = makeClientManager({ clientsInRoom: [client] });
    const getRoom = vi.fn(() => ({ getProducer: vi.fn(() => producer) }) as any);

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(producer.close).not.toHaveBeenCalled();
  });

  it("broadcasts seat:cleared with reason:shrink to the room for every evicted seat", async () => {
    const seatRepository = {
      evictSeatsAboveCount: vi.fn().mockResolvedValue([
        { seatIndex: 12, userId: 55 },
        { seatIndex: 13, userId: 66 },
      ]),
    } as any;
    const clientManager = makeClientManager();
    const getRoom = vi.fn(() => undefined);

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(io.to).toHaveBeenCalledWith("r1");
    expect(io.roomEmit).toHaveBeenCalledWith("seat:cleared", {
      seatIndex: 12,
      userId: 55,
      reason: "shrink",
    });
    expect(io.roomEmit).toHaveBeenCalledWith("seat:cleared", {
      seatIndex: 13,
      userId: 66,
      reason: "shrink",
    });
  });

  it("emits a targeted seat:evicted ONLY to the displaced user's room-scoped sockets", async () => {
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const clientManager = makeClientManager({
      socketIdsByUser: { 55: ["sock-a", "sock-b"] },
    });
    const getRoom = vi.fn(() => undefined);

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(clientManager.getSocketIdsByUserInRoom).toHaveBeenCalledWith(55, "r1");
    expect(io.to).toHaveBeenCalledWith(["sock-a", "sock-b"]);
    expect(io.targetedEmit).toHaveBeenCalledWith("seat:evicted", {
      roomId: "r1",
      seatIndex: 12,
      newSeatCount: 10,
    });
  });

  it("skips the targeted emit when the displaced user has no active room sockets", async () => {
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const clientManager = makeClientManager({ socketIdsByUser: {} });
    const getRoom = vi.fn(() => undefined);

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(io.targetedEmit).not.toHaveBeenCalled();
  });
});

// ─── Lua structural invariants (prior art: seat-retention.test.ts) ─────────
describe("SHRINK_EVICT_SCRIPT invariants", () => {
  it("scans the bounded seats hash and only touches indices >= newSeatCount", () => {
    expect(SHRINK_EVICT_SCRIPT).toContain("HGETALL");
    expect(SHRINK_EVICT_SCRIPT).toContain("idxNum >= newSeatCount");
  });

  it("HDELs the evicted seat and drops the user's reverse index", () => {
    expect(SHRINK_EVICT_SCRIPT).toContain("HDEL");
    expect(SHRINK_EVICT_SCRIPT).toContain("userSeatPrefix");
    expect(SHRINK_EVICT_SCRIPT).toContain("DEL");
  });

  it("returns {index,userId} pairs so the caller can act once per evicted seat", () => {
    expect(SHRINK_EVICT_SCRIPT).toMatch(
      /table\.insert\(evicted, \{ idxNum, tonumber\(data\.userId\) \}\)/,
    );
  });
});
