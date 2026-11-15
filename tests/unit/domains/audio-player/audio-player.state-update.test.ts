import { beforeEach, describe, expect, it, vi } from "vitest";

// room-music-playlist/03 — audioPlayer:stateUpdate is ONE Lua script (holder check +
// mutex refresh + state write). Handler seam only: redis.eval is mocked, so the
// Lua body itself is proven against a real Redis in
// tests/integration/audio-player/music-slot.redis.test.ts.

vi.mock("@src/config/index.js", () => ({ config: {} }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { eventsTotal: { inc: vi.fn() }, eventLatency: { observe: vi.fn() } },
}));
vi.mock("@src/shared/crypto.js", () => ({ generateCorrelationId: () => "test-correlation-id" }));

const broadcastToRoomMock = vi.fn();
const emitToRoomMock = vi.fn();
vi.mock("@src/shared/room-emit.js", () => ({
  broadcastToRoom: (...args: unknown[]) => broadcastToRoomMock(...args),
  emitToRoom: (...args: unknown[]) => emitToRoomMock(...args),
}));
vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn(),
  verifyRoomOwner: vi.fn(),
}));

import { audioPlayerHandler } from "@src/domains/audio-player/audio-player.handler.js";
import { Errors } from "@src/shared/errors.js";

const ROOM = "room-1";
const ME = 10;

function setup() {
  const socket = { id: "socket-1", data: { user: { id: ME } }, on: vi.fn() } as any;
  const context = {
    clientManager: { getClient: vi.fn().mockReturnValue({ roomId: ROOM }) },
    redis: {
      eval: vi.fn(),
      // The old non-atomic path — must never be touched again.
      get: vi.fn(),
      set: vi.fn(),
      setex: vi.fn(),
    },
    io: {},
    cascadeRelay: null,
  } as any;
  audioPlayerHandler(socket, context);
  const call = socket.on.mock.calls.find(([event]: [string]) => event === "audioPlayer:stateUpdate");
  const run = async (payload: unknown) => {
    const cb = vi.fn();
    await call[1](payload, cb);
    return cb.mock.calls[0]?.[0];
  };
  return { socket, context, run };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("audioPlayer:stateUpdate — one atomic script (room-music-playlist/03)", () => {
  it("the holder: one eval with both keys, then the unchanged cascade-aware stateChanged emit", async () => {
    const { socket, context, run } = setup();
    context.redis.eval.mockResolvedValue(1);

    const ack = await run({ roomId: ROOM, position: 42.5, isPaused: true });

    expect(ack).toEqual({ success: true });
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(context.redis.eval.mock.calls[0].slice(1)).toEqual([
      2,
      "room:room-1:musicPlayer",
      "room:room-1:musicState",
      "10", // holder id
      "7200", // MUSIC_PLAYER_TTL_SECONDS
      "42.5", // position
      "1", // isPaused
    ]);
    expect(emitToRoomMock).toHaveBeenCalledTimes(1);
    expect(emitToRoomMock).toHaveBeenCalledWith(
      socket,
      ROOM,
      "audioPlayer:stateChanged",
      { state: "paused", userId: ME, position: 42.5 },
      null,
    );
  });

  it("isPaused false is sent as '0' and relayed as state 'playing'", async () => {
    const { context, run } = setup();
    context.redis.eval.mockResolvedValue(1);

    await run({ roomId: ROOM, position: 3, isPaused: false });

    expect(context.redis.eval.mock.calls[0][7]).toBe("0");
    expect(emitToRoomMock.mock.calls[0][3]).toMatchObject({ state: "playing", position: 3 });
  });

  it("a non-holder gets NOT_AUTHORIZED and nothing is emitted", async () => {
    const { context, run } = setup();
    context.redis.eval.mockResolvedValue(0);

    const ack = await run({ roomId: ROOM, position: 1, isPaused: false });

    expect(ack).toEqual({ success: false, error: Errors.NOT_AUTHORIZED });
    expect(emitToRoomMock).not.toHaveBeenCalled();
  });

  it("never goes back to the racy GET → GET → SETEX round trips", async () => {
    const { context, run } = setup();
    context.redis.eval.mockResolvedValue(1);

    await run({ roomId: ROOM, position: 1, isPaused: false });

    expect(context.redis.get).not.toHaveBeenCalled();
    expect(context.redis.set).not.toHaveBeenCalled();
    expect(context.redis.setex).not.toHaveBeenCalled();
  });
});
