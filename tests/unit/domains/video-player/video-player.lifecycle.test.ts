import { beforeEach, describe, expect, it, vi } from "vitest";

// room-video-player/03 — release paths: the Controller's last live socket in the
// room disconnecting, explicit room:leave / room switch, and room close. The
// release itself is the real holder-checked Lua call (redis.eval mocked) plus
// the real `stateChanged null` broadcast (room-emit mocked).

const mockConfig = vi.hoisted(() => ({ VIDEO_PLAYER_ENABLED: true }));
vi.mock("@src/config/index.js", () => ({ config: mockConfig }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { eventsTotal: { inc: vi.fn() }, eventLatency: { observe: vi.fn() } },
}));

const broadcastToRoomMock = vi.fn();
vi.mock("@src/shared/room-emit.js", () => ({
  broadcastToRoom: (...args: unknown[]) => broadcastToRoomMock(...args),
  emitToRoom: vi.fn(),
}));

const userHasLiveSocketInRoomMock = vi.fn();
vi.mock("@src/domains/audio-player/index.js", () => ({
  userHasLiveSocketInRoom: (...args: unknown[]) => userHasLiveSocketInRoomMock(...args),
}));

import {
  videoPlayerLifecycle,
  releaseVideoOnRoomLeave,
  clearVideoPlayerForRoom,
} from "@src/domains/video-player/video-player.lifecycle.js";

const ROOM = "room-1";
const ME = 10;

function appCtx(controller: string | null) {
  return {
    redis: {
      get: vi.fn(async (key: string) => (key === `room:${ROOM}:videoPlayer` ? controller : null)),
      eval: vi.fn().mockResolvedValue(1), // RELEASE_VIDEO_SLOT_LUA: released
      del: vi.fn().mockResolvedValue(2),
    },
    io: {},
    cascadeRelay: null,
  } as any;
}

const disconnect = (ctx: any, roomId: string | null = ROOM) =>
  videoPlayerLifecycle.onDisconnect(
    { socket: { id: "dying" } as any, userId: ME, roomId, reason: "transport close" },
    ctx,
  );

const leavingSocket = { id: "leaving", data: { user: { id: ME } } } as any;

function expectReleased(ctx: any) {
  expect(ctx.redis.eval.mock.calls[0].slice(1)).toEqual([
    2,
    `room:${ROOM}:videoPlayer`,
    `room:${ROOM}:videoState`,
    String(ME),
  ]);
  expect(broadcastToRoomMock).toHaveBeenCalledWith(
    ctx.io,
    ROOM,
    "videoPlayer:stateChanged",
    { roomId: ROOM, snapshot: null },
    null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.VIDEO_PLAYER_ENABLED = true;
  userHasLiveSocketInRoomMock.mockResolvedValue(false);
});

describe("videoPlayerLifecycle.onDisconnect", () => {
  it("is registered under its own name", () => {
    expect(videoPlayerLifecycle.name).toBe("video-player");
  });

  it("releases when the Controller's last live socket in the room disconnects", async () => {
    const ctx = appCtx(String(ME));
    await disconnect(ctx);

    expect(userHasLiveSocketInRoomMock).toHaveBeenCalledWith(ctx, ME, ROOM, "dying");
    expectReleased(ctx);
  });

  it("keeps the video when the Controller still has another live socket in the room (refresh, second tab)", async () => {
    const ctx = appCtx(String(ME));
    userHasLiveSocketInRoomMock.mockResolvedValue(true);

    await disconnect(ctx);

    expect(ctx.redis.eval).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("a non-Controller's disconnect costs one GET — no liveness fan-out, no release", async () => {
    const ctx = appCtx("77");
    await disconnect(ctx);

    expect(ctx.redis.get).toHaveBeenCalledTimes(1);
    expect(userHasLiveSocketInRoomMock).not.toHaveBeenCalled();
    expect(ctx.redis.eval).not.toHaveBeenCalled();
  });

  it("does nothing for a socket that was in no room", async () => {
    const ctx = appCtx(String(ME));
    await disconnect(ctx, null);
    expect(ctx.redis.get).not.toHaveBeenCalled();
  });

  it("flag absent: never reads Redis", async () => {
    mockConfig.VIDEO_PLAYER_ENABLED = false;
    const ctx = appCtx(String(ME));
    await disconnect(ctx);
    expect(ctx.redis.get).not.toHaveBeenCalled();
    expect(ctx.redis.eval).not.toHaveBeenCalled();
  });
});

describe("releaseVideoOnRoomLeave (room:leave and room switch)", () => {
  it("releases the leaving Controller's video", async () => {
    const ctx = appCtx(String(ME));
    await releaseVideoOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(userHasLiveSocketInRoomMock).toHaveBeenCalledWith(ctx, ME, ROOM, "leaving");
    expectReleased(ctx);
  });

  it("keeps the video when the same user is still in the room on another socket", async () => {
    const ctx = appCtx(String(ME));
    userHasLiveSocketInRoomMock.mockResolvedValue(true);

    await releaseVideoOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.redis.eval).not.toHaveBeenCalled();
  });

  it("never throws — a Redis failure must not fail the leave (or the join that switched rooms)", async () => {
    const ctx = appCtx(String(ME));
    ctx.redis.get.mockRejectedValue(new Error("redis down"));

    await expect(releaseVideoOnRoomLeave(leavingSocket, ctx, ROOM)).resolves.toBeUndefined();
  });

  it("flag absent: never reads Redis", async () => {
    mockConfig.VIDEO_PLAYER_ENABLED = false;
    const ctx = appCtx(String(ME));
    await releaseVideoOnRoomLeave(leavingSocket, ctx, ROOM);
    expect(ctx.redis.get).not.toHaveBeenCalled();
  });
});

describe("clearVideoPlayerForRoom (room close)", () => {
  it("deletes both keys without a broadcast (room:closed already went out)", async () => {
    const ctx = appCtx(String(ME));
    await clearVideoPlayerForRoom(ctx.redis, ROOM);

    expect(ctx.redis.del).toHaveBeenCalledWith(`room:${ROOM}:videoPlayer`, `room:${ROOM}:videoState`);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("never rejects", async () => {
    const ctx = appCtx(null);
    ctx.redis.del.mockRejectedValue(new Error("redis down"));
    await expect(clearVideoPlayerForRoom(ctx.redis, ROOM)).resolves.toBeUndefined();
  });

  it("flag absent: touches nothing", async () => {
    mockConfig.VIDEO_PLAYER_ENABLED = false;
    const ctx = appCtx(null);
    await clearVideoPlayerForRoom(ctx.redis, ROOM);
    expect(ctx.redis.del).not.toHaveBeenCalled();
  });
});
