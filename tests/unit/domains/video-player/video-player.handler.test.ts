import { beforeEach, describe, expect, it, vi } from "vitest";

// room-video-player/02 + 03 — handler seam: captured socket.on registrations with
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
const verifyRoomOwnerMock = vi.fn();
vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: (...args: unknown[]) => verifyRoomManagerMock(...args),
  verifyRoomOwner: (...args: unknown[]) => verifyRoomOwnerMock(...args),
}));

// Fleet-wide view used by the targeted `revoked` emits (03). Default: nobody remote.
const fetchSocketsSafeMock = vi.fn();
vi.mock("@src/shared/fetch-sockets-safe.js", () => ({
  fetchSocketsSafe: (...args: unknown[]) => fetchSocketsSafeMock(...args),
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

/** Acquire-script replies (media-slot.redis.ts). */
const acquired = (stored: unknown, releasedMusic = "", previousVideo = "") => [
  "ok",
  JSON.stringify(stored),
  releasedMusic,
  previousVideo,
];
const busy = (kind: "music" | "video", holder: string) => ["busy", kind, holder];

function setup(opts: { inRoom?: boolean; socketsByUser?: Record<number, string[]> } = {}) {
  const socket = { id: "socket-1", data: { user: { id: ME } }, on: vi.fn() } as any;
  const emit = vi.fn();
  const context = {
    clientManager: {
      getClient: vi.fn().mockReturnValue(opts.inRoom === false ? null : { roomId: ROOM }),
      getSocketIdsByUserInRoom: vi.fn((uid: number) => opts.socketsByUser?.[uid] ?? []),
    },
    redis: { eval: vi.fn(), get: vi.fn(), set: vi.fn(), del: vi.fn() },
    io: { to: vi.fn().mockReturnValue({ emit }) },
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
  return { socket, context, handler, emit };
}

/** Targeted emits recorded as [socketIds, event, payload]. */
function targeted(context: any, emit: ReturnType<typeof vi.fn>) {
  return emit.mock.calls.map((call: unknown[], i: number) => [context.io.to.mock.calls[i][0], ...call]);
}

const ALL_EVENTS: Array<[string, Record<string, unknown>]> = [
  ["videoPlayer:play", { roomId: ROOM, source: YT }],
  ["videoPlayer:takeover", { roomId: ROOM, source: YT }],
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
  verifyRoomOwnerMock.mockResolvedValue({ allowed: true });
  userHasLiveSocketInRoomMock.mockResolvedValue(true);
  fetchSocketsSafeMock.mockResolvedValue([]);
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
    expect(verifyRoomOwnerMock).not.toHaveBeenCalled();
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

  it("acquires in one script that checks both mutexes and broadcasts the stored Snapshot", async () => {
    const { context, handler, emit } = setup();
    const stored = storedSnapshot({ title: "Trailer", durationSec: 120 });
    context.redis.eval.mockResolvedValue(acquired(stored));

    const ack = await handler("videoPlayer:play")({
      roomId: ROOM,
      source: YT,
      title: "Trailer",
      durationSec: 120,
    });

    expect(ack).toEqual({ success: true });
    const [, numKeys, ...rest] = context.redis.eval.mock.calls[0];
    const draftJson = rest[8];
    expect([numKeys, ...rest.slice(0, 8), rest[9]]).toEqual([
      4,
      "room:room-1:videoPlayer",
      "room:room-1:videoState",
      "room:room-1:musicPlayer",
      "room:room-1:musicState",
      "10",
      "", // no video steal
      "", // no music steal
      "7200",
      "0", // not forced
    ]);
    expect(JSON.parse(draftJson)).toMatchObject({
      controllerUserId: ME,
      source: YT,
      title: "Trailer",
      durationSec: 120,
      paused: false,
      positionAtTs: 0,
    });
    expect(broadcastToRoomMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      ROOM,
      "videoPlayer:stateChanged",
      { roomId: ROOM, snapshot: stored },
      null,
    );
    expect(emit).not.toHaveBeenCalled(); // nobody displaced
  });

  it("accepts an https HLS link", async () => {
    const { context, handler } = setup();
    const source = { kind: "url", url: "https://cdn.example.com/live/index.m3u8", container: "hls" };
    context.redis.eval.mockResolvedValue(acquired(storedSnapshot({ source })));
    expect(await handler("videoPlayer:play")({ roomId: ROOM, source })).toEqual({ success: true });
  });

  it("refuses with MEDIA_SLOT_BUSY when another live user holds the video", async () => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValue(busy("video", "77"));
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
      .mockResolvedValueOnce(busy("video", "77"))
      .mockResolvedValueOnce(acquired(storedSnapshot({ revision: 9 }), "", "77"));
    userHasLiveSocketInRoomMock.mockResolvedValue(false);

    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({ success: true });
    expect(context.redis.eval.mock.calls[1][7]).toBe("77"); // video steal ARGV
    expect(context.redis.eval.mock.calls[1][8]).toBe(""); // music steal untouched
    expect(broadcastToRoomMock).toHaveBeenCalledTimes(1);
  });

  it("reports busy when the steal CAS loses to a rival", async () => {
    const { context, handler } = setup();
    context.redis.eval.mockResolvedValueOnce(busy("video", "77")).mockResolvedValueOnce(busy("video", "88"));
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

describe("videoPlayer:play — one media slot with music (03)", () => {
  it("refuses MEDIA_SLOT_BUSY {heldBy:'music'} while another live user holds the music", async () => {
    const { context, handler, emit } = setup();
    context.redis.eval.mockResolvedValue(busy("music", "55"));

    const ack = await handler("videoPlayer:play")({ roomId: ROOM, source: YT });

    expect(ack).toEqual({ success: false, error: Errors.MEDIA_SLOT_BUSY, data: { heldBy: "music", userId: 55 } });
    expect(userHasLiveSocketInRoomMock).toHaveBeenCalledWith(context, 55, ROOM);
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("starting a video while holding the music yourself stops your music first, then starts the video", async () => {
    const { context, handler, emit } = setup({ socketsByUser: { [ME]: ["socket-1"] } });
    const stored = storedSnapshot();
    context.redis.eval.mockResolvedValue(acquired(stored, String(ME)));

    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({ success: true });

    expect(broadcastToRoomMock.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ["audioPlayer:stateChanged", { state: "stopped", userId: ME, title: null, duration: 0, position: 0 }],
      ["videoPlayer:stateChanged", { roomId: ROOM, snapshot: stored }],
    ]);
    // The DJ's own sockets get `revoked`: the frontend ignores stateChanged about
    // itself, so this is what stops its music producer.
    expect(targeted(context, emit)).toEqual([
      [["socket-1"], "audioPlayer:revoked", { roomId: ROOM, byUserId: ME, reason: "video" }],
    ]);
  });

  it("steals the music slot from a DJ with no live socket and tells the room the music stopped", async () => {
    const { context, handler } = setup();
    context.redis.eval
      .mockResolvedValueOnce(busy("music", "55"))
      .mockResolvedValueOnce(acquired(storedSnapshot(), "55"));
    userHasLiveSocketInRoomMock.mockResolvedValue(false);

    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({ success: true });
    expect(context.redis.eval.mock.calls[1][7]).toBe(""); // video steal
    expect(context.redis.eval.mock.calls[1][8]).toBe("55"); // music steal
    expect(broadcastToRoomMock.mock.calls[0]?.[3]).toMatchObject({ state: "stopped", userId: 55 });
  });

  it("steals a dead Controller then a dead DJ — three attempts, both steals carried", async () => {
    const { context, handler } = setup();
    context.redis.eval
      .mockResolvedValueOnce(busy("video", "77"))
      .mockResolvedValueOnce(busy("music", "55"))
      .mockResolvedValueOnce(acquired(storedSnapshot(), "55", "77"));
    userHasLiveSocketInRoomMock.mockResolvedValue(false);

    expect(await handler("videoPlayer:play")({ roomId: ROOM, source: YT })).toEqual({ success: true });
    expect(context.redis.eval).toHaveBeenCalledTimes(3);
    expect(context.redis.eval.mock.calls[2].slice(7, 9)).toEqual(["77", "55"]);
  });

  it("targets the displaced DJ fleet-wide: local sockets plus the adapter's view, deduplicated", async () => {
    const { context, handler, emit } = setup({ socketsByUser: { 55: ["local-55"] } });
    fetchSocketsSafeMock.mockResolvedValue([
      { id: "local-55", data: { user: { id: 55 } } },
      { id: "remote-55", data: { user: { id: 55 } } },
      { id: "remote-99", data: { user: { id: 99 } } },
    ]);
    context.redis.eval
      .mockResolvedValueOnce(busy("music", "55"))
      .mockResolvedValueOnce(acquired(storedSnapshot(), "55"));
    userHasLiveSocketInRoomMock.mockResolvedValue(false);

    await handler("videoPlayer:play")({ roomId: ROOM, source: YT });

    expect(targeted(context, emit)).toEqual([
      [["local-55", "remote-55"], "audioPlayer:revoked", { roomId: ROOM, byUserId: ME, reason: "video" }],
    ]);
  });
});

describe("videoPlayer:takeover — owner force-take (03)", () => {
  it("refuses an admin (verifyRoomOwner tier) and touches nothing", async () => {
    verifyRoomOwnerMock.mockResolvedValue({ allowed: false, error: Errors.NOT_AUTHORIZED });
    const { context, handler } = setup();

    expect(await handler("videoPlayer:takeover")({ roomId: ROOM, source: YT })).toEqual({
      success: false,
      error: Errors.NOT_AUTHORIZED,
    });
    expect(verifyRoomOwnerMock).toHaveBeenCalledWith(ROOM, String(ME), context);
    expect(verifyRoomManagerMock).not.toHaveBeenCalled();
    expect(context.redis.eval).not.toHaveBeenCalled();
  });

  it("refuses a socket that is not in the room before the owner check", async () => {
    const { handler } = setup({ inRoom: false });
    expect(await handler("videoPlayer:takeover")({ roomId: ROOM, source: YT })).toEqual({
      success: false,
      error: Errors.NOT_IN_ROOM,
    });
    expect(verifyRoomOwnerMock).not.toHaveBeenCalled();
  });

  it("applies the same Source rules as play", async () => {
    const { context, handler } = setup();
    const ack = await handler("videoPlayer:takeover")({
      roomId: ROOM,
      source: { kind: "url", url: "http://cdn.example.com/a.mp4", container: "mp4" },
    });
    expect(ack).toEqual({ success: false, error: Errors.VIDEO_SOURCE_INVALID });
    expect(context.redis.eval).not.toHaveBeenCalled();
  });

  it("forces the acquire, revokes the displaced Controller AND the displaced DJ, then starts the owner's video", async () => {
    const { context, handler, emit } = setup({ socketsByUser: { 77: ["s-77"], 55: ["s-55"] } });
    const stored = storedSnapshot({ revision: 12 });
    context.redis.eval.mockResolvedValue(acquired(stored, "55", "77"));

    expect(await handler("videoPlayer:takeover")({ roomId: ROOM, source: YT })).toEqual({ success: true });

    const args = context.redis.eval.mock.calls[0];
    expect(args.slice(7, 9)).toEqual(["", ""]); // no steals — force needs none
    expect(args[11]).toBe("1"); // forced
    expect(userHasLiveSocketInRoomMock).not.toHaveBeenCalled();
    expect(targeted(context, emit)).toEqual([
      [["s-55"], "audioPlayer:revoked", { roomId: ROOM, byUserId: ME, reason: "video" }],
      [["s-77"], "videoPlayer:revoked", { roomId: ROOM, byUserId: ME, reason: "takeover" }],
    ]);
    expect(broadcastToRoomMock.mock.calls.map((c) => c[2])).toEqual([
      "audioPlayer:stateChanged",
      "videoPlayer:stateChanged",
    ]);
    expect(broadcastToRoomMock.mock.calls[1]?.[3]).toEqual({ roomId: ROOM, snapshot: stored });
  });

  it("taking over your own video revokes nobody", async () => {
    const { context, handler, emit } = setup({ socketsByUser: { [ME]: ["socket-1"] } });
    context.redis.eval.mockResolvedValue(acquired(storedSnapshot(), "", String(ME)));

    expect(await handler("videoPlayer:takeover")({ roomId: ROOM, source: YT })).toEqual({ success: true });
    expect(emit).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).toHaveBeenCalledTimes(1);
  });
});
