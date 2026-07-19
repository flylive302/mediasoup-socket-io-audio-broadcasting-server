/**
 * Unit tests for evictShrunkSeats (room-seat-caps/02 — Seat Eviction (shrink);
 * dj-talk-over/02 — close ALL producers + release the music mutex).
 *
 * Scope: the EXECUTE+REACT sequence (producer close, mutex release, room
 * broadcast, targeted emit) given a set of {seatIndex,userId} pairs returned
 * by the atomic Lua clear. The Lua script's own structural invariants are
 * asserted separately below (prior art: seat-retention.test.ts's Lua
 * invariant suite).
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

/** Redis mock — musicPlayer mutex holder defaults to null (nobody playing). */
function makeRedis(currentPlayer: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(currentPlayer),
    del: vi.fn().mockResolvedValue(1),
    // music-dj-queue/04: release runs RELEASE_AND_GRANT_LUA (get+del → eval).
    // Emulate its contract against the single mutex holder; queue is empty in
    // these unit tests so a release always grants nothing (head '').
    eval: vi.fn(async (_script: string, numKeys: number, ...rest: string[]) => {
      const releasing = rest[numKeys]; // first ARGV after the KEYS
      if (currentPlayer !== null && String(currentPlayer) === String(releasing)) {
        return ["released", ""];
      }
      return ["denied", currentPlayer ?? ""];
    }),
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
    const redis = makeRedis();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(io.to).not.toHaveBeenCalled();
    expect(getRoom).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("closes ALL of the displaced user's producers (mic + music), ownership-verified", async () => {
    const micProducer = { closed: false, appData: { userId: 55 }, close: vi.fn() };
    const musicProducer = { closed: false, appData: { userId: 55 }, close: vi.fn() };
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const client = {
      userId: 55,
      producers: new Map([
        ["mic", "prod-mic"],
        ["music", "prod-music"],
      ]),
      isSpeaker: true,
    };
    const clientManager = makeClientManager({ clientsInRoom: [client] });
    const getRoom = vi.fn(() => ({
      getProducer: vi.fn((id: string) => (id === "prod-mic" ? micProducer : musicProducer)),
    }) as any);
    const redis = makeRedis();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(micProducer.close).toHaveBeenCalledTimes(1);
    expect(musicProducer.close).toHaveBeenCalledTimes(1);
    expect(client.producers.size).toBe(0);
    expect(client.isSpeaker).toBe(false);
  });

  it("releases the room's music mutex + broadcasts stop when the evicted user held it", async () => {
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const clientManager = makeClientManager();
    const getRoom = vi.fn(() => undefined);
    const redis = makeRedis("55"); // user 55 IS the current DJ

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      "room:r1:musicPlayer",
      "room:r1:musicState",
      "room:r1:musicQueue",
      "55",
      "15",
    );
    expect(io.roomEmit).toHaveBeenCalledWith(
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId: 55 }),
    );
  });

  it("leaves the music mutex untouched when the evicted user did NOT hold it", async () => {
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const clientManager = makeClientManager();
    const getRoom = vi.fn(() => undefined);
    const redis = makeRedis("99"); // a different user is the current DJ

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
      cascadeRelay: null,
      seatRepository,
      clientManager,
      getRoom,
    });

    expect(redis.del).not.toHaveBeenCalled();
    // Only the standard seat:cleared broadcast fires — no stateChanged stop.
    expect(io.roomEmit).not.toHaveBeenCalledWith(
      "audioPlayer:stateChanged",
      expect.anything(),
    );
  });

  it("skips producer close when ownership no longer matches (F-45 guard)", async () => {
    const producer = { closed: false, appData: { userId: 999 }, close: vi.fn() };
    const seatRepository = {
      evictSeatsAboveCount: vi
        .fn()
        .mockResolvedValue([{ seatIndex: 12, userId: 55 }]),
    } as any;
    const client = { userId: 55, producers: new Map([["mic", "prod-1"]]), isSpeaker: true };
    const clientManager = makeClientManager({ clientsInRoom: [client] });
    const getRoom = vi.fn(() => ({ getProducer: vi.fn(() => producer) }) as any);
    const redis = makeRedis();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
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
    const redis = makeRedis();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
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
    const redis = makeRedis();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
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
    const redis = makeRedis();

    await evictShrunkSeats({
      roomId: "r1",
      newSeatCount: 10,
      io,
      redis,
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
