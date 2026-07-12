import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config + logger BEFORE importing the handler — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
vi.mock("@src/config/index.js", () => ({ config: {} }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
  },
}));

// F-45: seat:lock must not close a producer that no longer belongs to the
// kicked user. A rapid disconnect→reconnect→produce (or mute/unmute) can
// replace `client.producers.get("mic")` with a brand-new producer; without
// the ownership guard the lock handler would close that new producer.
//
// dj-talk-over/02: seat:lock now closes EVERY producer the kicked user
// holds (mic + music) and releases the room's music mutex + broadcasts
// stop if the kicked user held it.

vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@src/shared/room-emit.js", () => ({
  broadcastToRoom: vi.fn(),
}));

import { lockSeatHandler } from "@src/domains/seat/handlers/lock-seat.handler.js";

function makeProducer(userId: number) {
  return {
    id: `prod-${userId}`,
    closed: false,
    close: vi.fn(),
    appData: { userId },
  };
}

function makeContext(
  kickedUserId: number,
  producerUserId: number,
  opts: { currentMusicPlayer?: string | null } = {},
) {
  const producer = makeProducer(producerUserId);
  const room = { getProducer: vi.fn().mockReturnValue(producer) };
  const kickedClient = {
    userId: kickedUserId,
    producers: new Map<string, string>([["mic", producer.id]]),
    isSpeaker: true,
  };
  const redis = {
    get: vi.fn().mockResolvedValue(opts.currentMusicPlayer ?? null),
    del: vi.fn().mockResolvedValue(1),
  };
  const io = { to: vi.fn(), on: vi.fn() };
  const context = {
    seatRepository: {
      lockSeat: vi.fn().mockResolvedValue({
        success: true,
        kicked: String(kickedUserId),
      }),
    },
    clientManager: {
      getClientsInRoom: vi.fn().mockReturnValue([kickedClient]),
    },
    roomManager: { getRoom: vi.fn().mockReturnValue(room) },
    cascadeRelay: null,
    redis,
    io,
  };
  const socket = {
    data: { user: { id: 99 } },
    nsp: {},
  };
  return { producer, kickedClient, context, socket, redis, io };
}

describe("seat:lock — producer ownership (F-45)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes the audio producer when it still belongs to the kicked user", async () => {
    const { producer, context, socket } = makeContext(7, 7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });
    expect(producer.close).toHaveBeenCalledTimes(1);
  });

  it("SKIPS the close when the producer's appData.userId no longer matches", async () => {
    const { producer, context, socket } = makeContext(7, 42); // mismatch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });
    expect(producer.close).not.toHaveBeenCalled();
  });

  // dj-talk-over/02: seat-lock now closes ALL producers the kicked user
  // holds — mic AND music — instead of mic only.
  it("closes BOTH the mic and a concurrent music producer", async () => {
    const micProducer = makeProducer(7);
    const musicProducer = { ...makeProducer(7), close: vi.fn() };
    const room = {
      getProducer: vi.fn((id: string) => (id === micProducer.id ? micProducer : musicProducer)),
    };
    const kickedClient = {
      userId: 7,
      producers: new Map<string, string>([
        ["mic", micProducer.id],
        ["music", "prod-music-7"],
      ]),
      isSpeaker: true,
    };
    const redis = { get: vi.fn().mockResolvedValue(null), del: vi.fn() };
    const io = { to: vi.fn(), on: vi.fn() };
    const context = {
      seatRepository: {
        lockSeat: vi.fn().mockResolvedValue({ success: true, kicked: "7" }),
      },
      clientManager: { getClientsInRoom: vi.fn().mockReturnValue([kickedClient]) },
      roomManager: { getRoom: vi.fn().mockReturnValue(room) },
      cascadeRelay: null,
      redis,
      io,
    };
    const socket = { data: { user: { id: 99 } }, nsp: {} };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });

    expect(micProducer.close).toHaveBeenCalledTimes(1);
    expect(musicProducer.close).toHaveBeenCalledTimes(1);
    expect(kickedClient.producers.size).toBe(0);
    expect(kickedClient.isSpeaker).toBe(false);
  });

  it("releases the room's music mutex + broadcasts stop when the kicked user held it", async () => {
    const { context, socket, redis, io } = makeContext(7, 7, { currentMusicPlayer: "7" });
    const emitMock = vi.fn();
    io.to.mockReturnValue({ emit: emitMock });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });

    expect(redis.del).toHaveBeenCalledWith("room:room-1:musicPlayer");
    expect(redis.del).toHaveBeenCalledWith("room:room-1:musicState");
  });

  it("leaves the music mutex untouched when the kicked user did NOT hold it", async () => {
    const { context, socket, redis } = makeContext(7, 7, { currentMusicPlayer: "42" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });

    expect(redis.del).not.toHaveBeenCalled();
  });
});
