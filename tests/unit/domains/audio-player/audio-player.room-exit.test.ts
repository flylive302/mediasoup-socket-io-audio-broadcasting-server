import { beforeEach, describe, expect, it, vi } from "vitest";

// room-music-playlist/02 — the music mutex is released on an explicit room:leave
// (and the implicit room switch), through the SAME shared function the disconnect
// hook uses: another-live-socket guard → LREM from the queue → release + `stopped`.

vi.mock("@src/config/index.js", () => ({ config: {} }));
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

const reactErrorMock = vi.fn();
vi.mock("@src/shared/react-error.js", () => ({
  reactError: (...args: unknown[]) => reactErrorMock(...args),
}));
vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn(),
  verifyRoomOwner: vi.fn(),
}));

import {
  audioPlayerLifecycle,
  releaseMusicOnRoomExit,
  releaseMusicOnRoomLeave,
} from "@src/domains/audio-player/audio-player.lifecycle.js";

const ROOM = "room-1";
const ME = 10;
const leavingSocket = { id: "leaving", data: { user: { id: ME } } } as any;

function appCtx(opts: { localSocketIds?: string[]; remoteSockets?: Array<{ id: string; data: { user: { id: number } } }> } = {}) {
  return {
    redis: {
      // Leave-path pre-check: default = the leaver holds the music mutex, not queued.
      get: vi.fn().mockResolvedValue(String(ME)),
      lpos: vi.fn().mockResolvedValue(null),
      // RELEASE_AND_GRANT_LUA: default = the leaver IS the holder, empty queue.
      eval: vi.fn().mockResolvedValue(["released", ""]),
      lrem: vi.fn().mockResolvedValue(0),
    },
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue(opts.remoteSockets ?? []),
        local: { fetchSockets: vi.fn().mockResolvedValue([]) },
      }),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    },
    clientManager: {
      getSocketIdsByUserInRoom: vi.fn().mockReturnValue(opts.localSocketIds ?? []),
    },
    cascadeRelay: null,
  } as any;
}

function expectReleased(ctx: any) {
  expect(ctx.redis.eval).toHaveBeenCalledWith(
    expect.any(String),
    3,
    "room:room-1:musicPlayer",
    "room:room-1:musicState",
    "room:room-1:musicQueue",
    String(ME),
    "15",
  );
  expect(broadcastToRoomMock).toHaveBeenCalledWith(
    ctx.io,
    ROOM,
    "audioPlayer:stateChanged",
    { state: "stopped", userId: ME, title: null, duration: 0, position: 0 },
    null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("releaseMusicOnRoomLeave (room:leave and room switch)", () => {
  it("the DJ leaves → dequeued, mutex + state released through the Lua, `stopped` broadcast", async () => {
    const ctx = appCtx();

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.redis.lrem).toHaveBeenCalledWith("room:room-1:musicQueue", 0, String(ME));
    expectReleased(ctx);
  });

  it("dequeues BEFORE the release, so a dead DJ who was also queued cannot be granted to themself", async () => {
    const ctx = appCtx();

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.redis.lrem.mock.invocationCallOrder[0]).toBeLessThan(ctx.redis.eval.mock.invocationCallOrder[0]);
  });

  it("excludes the LEAVING socket id from the liveness check (its own socket does not count)", async () => {
    // Only the leaving socket itself is still listed for this user in the room.
    const ctx = appCtx({ localSocketIds: ["leaving"] });

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expectReleased(ctx);
  });

  it("keeps the mutex when the same user has a SECOND live socket in the room (local)", async () => {
    const ctx = appCtx({ localSocketIds: ["leaving", "second-tab"] });

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.redis.lrem).not.toHaveBeenCalled();
    expect(ctx.redis.eval).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("keeps the mutex when the second live socket is on ANOTHER instance", async () => {
    const ctx = appCtx({ remoteSockets: [{ id: "remote-sock", data: { user: { id: ME } } }] });

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.io.in).toHaveBeenCalledWith(ROOM);
    expect(ctx.redis.lrem).not.toHaveBeenCalled();
    expect(ctx.redis.eval).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("a waiter (not the DJ) who leaves is removed from the queue and the music keeps playing", async () => {
    const ctx = appCtx();
    ctx.redis.get.mockResolvedValue("55"); // somebody else holds the slot
    ctx.redis.lpos.mockResolvedValue(0); // the leaver is queued
    ctx.redis.eval.mockResolvedValue(["denied", "55"]); // somebody else holds the slot

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.redis.lrem).toHaveBeenCalledWith("room:room-1:musicQueue", 0, String(ME));
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("a bystander (not the DJ, not queued) costs one cheap read — no fleet socket fetch, no write", async () => {
    const ctx = appCtx();
    ctx.redis.get.mockResolvedValue("55");
    ctx.redis.lpos.mockResolvedValue(null);

    await releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM);

    expect(ctx.redis.get).toHaveBeenCalledWith("room:room-1:musicPlayer");
    expect(ctx.redis.lpos).toHaveBeenCalledWith("room:room-1:musicQueue", String(ME));
    expect(ctx.io.in).not.toHaveBeenCalled();
    expect(ctx.clientManager.getSocketIdsByUserInRoom).not.toHaveBeenCalled();
    expect(ctx.redis.lrem).not.toHaveBeenCalled();
    expect(ctx.redis.eval).not.toHaveBeenCalled();
  });

  it("never throws — a Redis failure must not fail the leave (or the join that switched rooms)", async () => {
    const ctx = appCtx();
    ctx.redis.lrem.mockRejectedValue(new Error("redis down"));

    await expect(releaseMusicOnRoomLeave(leavingSocket, ctx, ROOM)).resolves.toBeUndefined();
    expect(reactErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      { roomId: ROOM, userId: ME },
      expect.stringContaining("room:leave"),
    );
  });
});

describe("releaseMusicOnRoomExit — the one shared release (disconnect hook + room:leave)", () => {
  it("is what the disconnect hook runs: release when the dying socket was the last one", async () => {
    const ctx = appCtx({ localSocketIds: ["dying"] });

    await audioPlayerLifecycle.onDisconnect(
      { socket: { id: "dying" } as any, userId: ME, roomId: ROOM, reason: "transport close" },
      ctx,
    );

    expectReleased(ctx);
  });

  it("propagates failures (the disconnect path keeps today's behaviour; only the leave wrapper swallows)", async () => {
    const ctx = appCtx();
    ctx.redis.lrem.mockRejectedValue(new Error("redis down"));

    await expect(releaseMusicOnRoomExit(ctx, ROOM, ME, "leaving")).rejects.toThrow("redis down");
  });
});
