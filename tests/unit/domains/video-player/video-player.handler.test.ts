import { beforeEach, describe, expect, it, vi } from "vitest";

// room-video-player/02 — handler seam: captured socket.on registrations with
// mocked Redis, room-emit, seat.owner and config. The Lua bodies themselves run
// against a real Redis in tests/integration/video-player/video-state.redis.test.ts.

const mockConfig = vi.hoisted(() => ({ VIDEO_PLAYER_ENABLED: true }));
vi.mock("@src/config/index.js", () => ({ config: mockConfig }));
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

const verifyRoomManagerMock = vi.fn();
vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: (...args: unknown[]) => verifyRoomManagerMock(...args),
  verifyRoomOwner: vi.fn(),
}));

const userHasLiveSocketInRoomMock = vi.fn();
vi.mock("@src/domains/audio-player/index.js", () => ({
  userHasLiveSocketInRoom: (...args: unknown[]) => userHasLiveSocketInRoomMock(...args),
}));

import { videoPlayerHandler } from "@src/domains/video-player/video-player.handler.js";
import { Errors } from "@src/shared/errors.js";

const ROOM = "room-1";
const ME = 10;
const YT = { kind: "youtube", videoId: "dQw4w9WgXcQ" } as const;

function storedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    controllerUserId: ME,
    source: YT,
    paused: false,
    positionAtTs: 0,
    serverTs: 1_700_000_000_000,
    revision: 1,
    ...overrides,
  };
}

function setup(opts: { inRoom?: boolean } = {}) {
  const socket = { id: "socket-1", data: { user: { id: ME } }, on: vi.fn() } as any;
  const context = {
    clientManager: {
      getClient: vi.fn().mockReturnValue(opts.inRoom === false ? null : { roomId: ROOM }),
    },
    redis: { eval: vi.fn(), get: vi.fn(), set: vi.fn(), del: vi.fn() },
    io: {},
    cascadeRelay: null,
  } as any;
  videoPlayerHandler(socket, context);
  const handler = (event: string) => {
    const call = socket.on.mock.calls.find(([name]: [string]) => name === event);
    if (!call) throw new Error(`${event} not registered`);
    return async (payload: unknown) => {
      const cb = vi.fn();
      await call[1](payload, cb);
      return cb.mock.calls[0]?.[0];
    };
  };
  return { socket, context, handler };
}

const ALL_EVENTS: Array<[string, Record<string, unknown>]> = [
  ["videoPlayer:play", { roomId: ROOM, source: YT }],
  ["videoPlayer:pause", { roomId: ROOM, positionSec: 5 }],
  ["videoPlayer:resume", { roomId: ROOM, positionSec: 5 }],
  ["videoPlayer:seek", { roomId: ROOM, positionSec: 5 }],
  ["videoPlayer:heartbeat", { roomId: ROOM, positionSec: 5, paused: false }],
  ["videoPlayer:stop", { roomId: ROOM }],
  ["videoPlayer:ended", { roomId: ROOM }],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.VIDEO_PLAYER_ENABLED = true;
  verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  userHasLiveSocketInRoomMock.mockResolvedValue(true);
});

describe("videoPlayer:* — flag absent", () => {
  it.each(ALL_EVENTS)("%s refuses with VIDEO_PLAYER_DISABLED and touches nothing", async (event, payload) => {
    mockConfig.VIDEO_PLAYER_ENABLED = false;
    const { context, handler } = setup();

    const ack = await handler(event)(payload);

    expect(ack).toEqual({ success: false, error: Errors.VIDEO_PLAYER_DISABLED });
    expect(context.redis.eval).not.toHaveBeenCalled();
    expect(context.redis.get).not.toHaveBeenCalled();
    expect(verifyRoomManagerMock).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });
});

describe("videoPlayer:play — GATE order and acquire", () => {
  it("refuses a socket that is not in the room", async () => {
    const { handler } = setup({ inRoom: false });
    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({
      success: false,
      error: Errors.NOT_IN_ROOM,
    });
    expect(verifyRoomManagerMock).not.toHaveBeenCalled();
  });

  it("refuses a non-manager with the seat.owner error", async () => {
    verifyRoomManagerMock.mockResolvedValue({ allowed: false, error: Errors.NOT_AUTHORIZED });
    const { context, handler } = setup();
    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({
      success: false,
      error: Errors.NOT_AUTHORIZED,
    });
    expect(verifyRoomManagerMock).toHaveBeenCalledWith(ROOM, String(ME), context);
    expect(context.redis.eval).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "http://cdn.example.com/a.mp4"],
    ["javascript", "javascript:alert(1)//.mp4"],
    ["unparseable", "not a url"],
    ["over 2048 chars", `https://cdn.example.com/${"a".repeat(2048)}.mp4`],
  ])("refuses a %s direct link with VIDEO_SOURCE_INVALID", async (_label, url) => {
    const { context, handler } = setup();
    const ack = await handler("videoPlayer:play")({
      roomId: ROOM,
      source: { kind: "url", url, container: "mp4" },
    });
    expect(ack).toEqual({ success: false, error: Errors.VIDEO_SOURCE_INVALID });
    expect(context.redis.eval).not.toHaveBeenCalled();
  });

  it("rejects a malformed Source at the schema (missing container, bad YouTube id)", async () => {
    const { handler } = setup();
    expect(
      await handler("videoPlayer:play")({ roomId: ROOM, source: { kind: "url", url: "https://x.example/a.mp4" } }),
    ).toEqual({ success: false, error: Errors.INVALID_PAYLOAD });
    expect(
      await handler("videoPlayer:play")({ roomId: ROOM, source: { kind: "youtube", videoId: "short" } }),
    ).toEqual({ success: false, error: Errors.INVALID_PAYLOAD });
  });

  it("acquires both keys in one script and broadcasts the stored Snapshot to the room", async () => {
    const { context, handler } = setup();
    const stored = storedSnapshot({ title: "Trailer", durationSec: 120 });
    context.redis.eval.mockResolvedValue([String(ME), JSON.stringify(stored)]);

    const ack = await handler("videoPlayer:play")({
      roomId: ROOM,
      source: YT,
      title: "Trailer",
      durationSec: 120,
    });

    expect(ack).toEqual({ success: true });
    const [, numKeys, mutexKey, stateKey, me, steal, ttl, draftJson] = context.redis.eval.mock.calls[0];
    expect([numKeys, mutexKey, stateKey, me, steal, ttl]).toEqual([
      2,
      "room:room-1:videoPlayer",
      "room:room-1:videoState",
      "10",
      "",
      "7200",
    ]);
    expect(JSON.parse(draftJson)).toMatchObject({
      controllerUserId: ME,
      source: YT,
      title: "Trailer",
      durationSec: 120,
      paused: false,
      positionAtTs: 0,
    });
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      ROOM,
      "videoPlayer:stateChanged",
      { roomId: ROOM, snapshot: stored },
      null,
    );
  });

  it("accepts an https HLS link", async () => {
    const { context, handler } = setup();
    const source = { kind: "url", url: "https://cdn.example.com/live/index.m3u8", container: "hls" };
    context.redis.eval.mockResolvedValue([String(ME), JSON.stringify(storedSnapshot({ source }))]);
    expect(await handler("videoPlayer:play")({ roomId: ROOM, source })).toEqual({ success: true });
  });

  it("refuses with MEDIA_SLOT_BUSY when another live user holds the video", async () => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValue(["77"]);
    userHasLiveSocketInRoomMock.mockResolvedValue(true);

    const ack = await handler("videoPlayer:play")({ roomId: ROOM, source: YT });

    expect(ack).toEqual({
      success: false,
      error: Errors.MEDIA_SLOT_BUSY,
      data: { heldBy: "video", userId: 77 },
    });
    expect(userHasLiveSocketInRoomMock).toHaveBeenCalledWith(context, 77, ROOM);
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("CAS-steals a slot whose holder has no live socket in the room", async () => {
    const { context, handler } = setup();
    context.redis.eval
      .mockResolvedValueOnce(["77"])
      .mockResolvedValueOnce([String(ME), JSON.stringify(storedSnapshot({ revision: 9 }))]);
    userHasLiveSocketInRoomMock.mockResolvedValue(false);

    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({ success: true });
    expect(context.redis.eval.mock.calls[1][5]).toBe("77"); // steal ARGV
    expect(broadcastToRoomMock).toHaveBeenCalledTimes(1);
  });

  it("reports busy when the steal CAS loses to a rival", async () => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValueOnce(["77"]).mockResolvedValueOnce(["88"]);
    userHasLiveSocketInRoomMock.mockResolvedValue(false);

    const ack = await handler("videoPlayer:play")({ roomId: ROOM, source: YT });
    expect(ack).toMatchObject({ success: false, error: Errors.MEDIA_SLOT_BUSY, data: { userId: 88 } });
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });
});

describe("videoPlayer:pause / resume / seek — Controller writes", () => {
  it.each([
    ["videoPlayer:pause", "pause", true],
    ["videoPlayer:resume", "play", false],
    ["videoPlayer:seek", "keep", true],
  ])("%s stores the position with paused mode %s and broadcasts", async (event, mode, paused) => {
    const { context, handler } = setup();
    const stored = storedSnapshot({ paused, positionAtTs: 42.5, revision: 3 });
    context.redis.eval.mockResolvedValue(JSON.stringify(stored));
    const before = Date.now();

    const ack = await handler(event)({ roomId: ROOM, positionSec: 42.5 });

    expect(ack).toEqual({ success: true });
    const args = context.redis.eval.mock.calls[0];
    expect(args.slice(1, 7)).toEqual([2, "room:room-1:videoPlayer", "room:room-1:videoState", "10", "7200", "42.5"]);
    expect(Number(args[7])).toBeGreaterThanOrEqual(before); // serverTs = now
    expect(args[8]).toBe(mode);
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      ROOM,
      "videoPlayer:stateChanged",
      { roomId: ROOM, snapshot: stored },
      null,
    );
  });

  it("refuses a non-Controller with NOT_AUTHORIZED and broadcasts nothing", async () => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValue(null);
    expect(await handler("videoPlayer:pause")({ roomId: ROOM, positionSec: 1 })).toEqual({
      success: false,
      error: Errors.NOT_AUTHORIZED,
    });
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("refuses a socket that is not in the room", async () => {
    const { context, handler } = setup({ inRoom: false });
    expect(await handler("videoPlayer:seek")({ roomId: ROOM, positionSec: 1 })).toEqual({
      success: false,
      error: Errors.NOT_IN_ROOM,
    });
    expect(context.redis.eval).not.toHaveBeenCalled();
  });

  it("rejects a negative position at the schema", async () => {
    const { handler } = setup();
    expect(await handler("videoPlayer:seek")({ roomId: ROOM, positionSec: -1 })).toEqual({
      success: false,
      error: Errors.INVALID_PAYLOAD,
    });
  });
});

describe("videoPlayer:heartbeat", () => {
  it.each([
    [false, "play"],
    [true, "pause"],
  ])("paused=%s writes mode %s and is never relayed to the room", async (paused, mode) => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValue(JSON.stringify(storedSnapshot({ paused })));

    const ack = await handler("videoPlayer:heartbeat")({ roomId: ROOM, positionSec: 30, paused });

    expect(ack).toEqual({ success: true });
    expect(context.redis.eval.mock.calls[0][8]).toBe(mode);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(emitToRoomMock).not.toHaveBeenCalled();
  });

  it("refuses a non-Controller with NOT_AUTHORIZED", async () => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValue(null);
    expect(await handler("videoPlayer:heartbeat")({ roomId: ROOM, positionSec: 1, paused: false })).toEqual({
      success: false,
      error: Errors.NOT_AUTHORIZED,
    });
  });
});

describe("videoPlayer:stop / ended", () => {
  it.each(["videoPlayer:stop", "videoPlayer:ended"])(
    "%s releases both keys and broadcasts a null Snapshot (sender included)",
    async (event) => {
      const { context, handler } = setup();
      context.redis.eval.mockResolvedValue(1);

      expect(await handler(event)({ roomId: ROOM })).toEqual({ success: true });
      expect(context.redis.eval.mock.calls[0].slice(1)).toEqual([
        2,
        "room:room-1:videoPlayer",
        "room:room-1:videoState",
        "10",
      ]);
      expect(broadcastToRoomMock).toHaveBeenCalledWith(
        context.io,
        ROOM,
        "videoPlayer:stateChanged",
        { roomId: ROOM, snapshot: null },
        null,
      );
    },
  );

  it.each(["videoPlayer:stop", "videoPlayer:ended"])(
    "%s from a non-Controller is NOT_AUTHORIZED and silent",
    async (event) => {
      const { context, handler } = setup();
      context.redis.eval.mockResolvedValue(0);
      expect(await handler(event)({ roomId: ROOM })).toEqual({ success: false, error: Errors.NOT_AUTHORIZED });
      expect(broadcastToRoomMock).not.toHaveBeenCalled();
    },
  );
});
