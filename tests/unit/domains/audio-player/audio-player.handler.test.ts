import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-correlation-id",
}));

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

import {
  audioPlayerHandler,
  releaseMusicPlayerForUser,
} from "@src/domains/audio-player/audio-player.handler.js";
import { audioPlayerLifecycle } from "@src/domains/audio-player/audio-player.lifecycle.js";
import { Errors } from "@src/shared/errors.js";

function createMockSocket(userId: number) {
  return {
    id: "socket-1",
    data: { user: { id: userId } },
    on: vi.fn(),
  } as any;
}

function createMockContext(clientRoomId: string | null) {
  return {
    clientManager: {
      getClient: vi.fn().mockReturnValue(clientRoomId ? { roomId: clientRoomId } : null),
      // music-dj-queue/01: liveness source of truth for the steal path.
      getSocketIdsByUserInRoom: vi.fn().mockReturnValue([]),
    },
    redis: {
      set: vi.fn().mockResolvedValue("OK"),
      setex: vi.fn().mockResolvedValue("OK"),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      // Default: acquire succeeds (script returns the requesting userId).
      eval: vi.fn(),
    },
    // Cross-instance liveness lookup (music-dj-queue/01) — default: no remote
    // sockets, so the fleet-wide check falls back to the local clientManager.
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue([]),
        local: { fetchSockets: vi.fn().mockResolvedValue([]) },
      }),
    },
    cascadeRelay: null,
  } as any;
}

function getPlayHandler(socket: any, context: any) {
  audioPlayerHandler(socket, context);
  const call = socket.on.mock.calls.find(([event]: [string]) => event === "audioPlayer:play");
  return call[1];
}

function getTakeoverHandler(socket: any, context: any) {
  audioPlayerHandler(socket, context);
  const call = socket.on.mock.calls.find(([event]: [string]) => event === "audioPlayer:takeover");
  return call[1];
}

/** Context with a chainable `io.to(...).emit(...)` spy and room-scoped lookup. */
function createTakeoverContext(opts: {
  clientRoomId: string | null;
  currentPlayer: string | null;
  displacedSocketIds?: string[];
}) {
  const emitMock = vi.fn();
  return {
    context: {
      clientManager: {
        getClient: vi.fn().mockReturnValue(opts.clientRoomId ? { roomId: opts.clientRoomId } : null),
        getSocketIdsByUserInRoom: vi.fn().mockReturnValue(opts.displacedSocketIds ?? []),
      },
      redis: {
        set: vi.fn().mockResolvedValue("OK"),
        setex: vi.fn().mockResolvedValue("OK"),
        get: vi.fn().mockResolvedValue(opts.currentPlayer),
        del: vi.fn().mockResolvedValue(1),
      },
      io: { to: vi.fn().mockReturnValue({ emit: emitMock }) },
      cascadeRelay: null,
    } as any,
    emitMock,
  };
}

describe("audioPlayer:play — MSAB play role gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owner acquires a free slot", async () => {
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
    const socket = createMockSocket(10);
    const context = createMockContext("room-1");
    context.redis.eval.mockResolvedValue("10"); // slot acquired
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song A", duration: 180 }, cb);

    expect(verifyRoomManagerMock).toHaveBeenCalledWith("room-1", "10", context);
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "playing", userId: 10 }),
      context.cascadeRelay,
    );
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("admin acquires a free slot", async () => {
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
    const socket = createMockSocket(20);
    const context = createMockContext("room-1");
    context.redis.eval.mockResolvedValue("20"); // slot acquired
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(verifyRoomManagerMock).toHaveBeenCalledWith("room-1", "20", context);
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("rejects a non-manager and does not acquire the mutex", async () => {
    verifyRoomManagerMock.mockResolvedValue({ allowed: false, error: Errors.NOT_AUTHORIZED });
    const socket = createMockSocket(30);
    const context = createMockContext("room-1");
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song C", duration: 120 }, cb);

    expect(verifyRoomManagerMock).toHaveBeenCalledWith("room-1", "30", context);
    expect(context.redis.eval).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.NOT_AUTHORIZED });
  });

  it("rejects when the user is not in the room (unchanged, runs before the role gate)", async () => {
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
    const socket = createMockSocket(40);
    const context = createMockContext("other-room");
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song D", duration: 90 }, cb);

    expect(verifyRoomManagerMock).not.toHaveBeenCalled();
    expect(context.redis.eval).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.NOT_IN_ROOM });
  });
});

describe("audioPlayer:play — stale-proof slot acquisition (music-dj-queue/01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  });

  it("reuse-if-mine: holder == requester → success, TTL refreshed, no liveness check", async () => {
    const socket = createMockSocket(10);
    const context = createMockContext("room-1");
    // Phase-1 script re-SETs and returns the requester's own id.
    context.redis.eval.mockResolvedValue("10");
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song A", duration: 180 }, cb);

    // Only the phase-1 acquire ran; no steal, no liveness lookup.
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(context.redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "room:room-1:musicPlayer",
      "10",
      "", // steal branch disabled on phase 1
      "7200",
    );
    expect(context.clientManager.getSocketIdsByUserInRoom).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("track-change by current DJ never returns MUSIC_ALREADY_PLAYING", async () => {
    // Same as reuse-if-mine from the caller's perspective: a live DJ pressing
    // next/prev/auto-advance re-acquires their own slot.
    const socket = createMockSocket(10);
    const context = createMockContext("room-1");
    context.redis.eval.mockResolvedValue("10");
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Next Track", duration: 210 }, cb);

    expect(context.clientManager.getSocketIdsByUserInRoom).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("live-holder denial: different holder with a live socket in the room → denied, no steal", async () => {
    const socket = createMockSocket(20); // requester
    const context = createMockContext("room-1");
    context.redis.eval.mockResolvedValue("10"); // phase 1 returns the live holder
    context.clientManager.getSocketIdsByUserInRoom.mockReturnValue(["sock-live"]);
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(context.clientManager.getSocketIdsByUserInRoom).toHaveBeenCalledWith(10, "room-1");
    // No steal attempt — phase-2 eval must NOT run.
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.MUSIC_ALREADY_PLAYING });
  });

  it("dead-holder steal: different holder with zero live sockets → slot stolen, requester becomes DJ", async () => {
    const socket = createMockSocket(20); // requester
    const context = createMockContext("room-1");
    // Phase 1 returns the dead holder "10"; phase-2 CAS steal returns requester "20".
    context.redis.eval
      .mockResolvedValueOnce("10")
      .mockResolvedValueOnce("20");
    context.clientManager.getSocketIdsByUserInRoom.mockReturnValue([]); // no live sockets
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(context.clientManager.getSocketIdsByUserInRoom).toHaveBeenCalledWith(10, "room-1");
    // Phase-2 CAS steal passes the dead holder as the steal token.
    expect(context.redis.eval).toHaveBeenCalledTimes(2);
    expect(context.redis.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      "room:room-1:musicPlayer",
      "20",
      "10", // steal only if key still equals the dead holder
      "7200",
    );
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "playing", userId: 20 }),
      context.cascadeRelay,
    );
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("steal race lost: CAS returns another id (a rival won) → denied", async () => {
    const socket = createMockSocket(20);
    const context = createMockContext("room-1");
    // Phase 1 sees dead holder "10"; between the liveness check and the CAS,
    // rival "30" acquired — phase-2 CAS returns "30", not the requester.
    context.redis.eval
      .mockResolvedValueOnce("10")
      .mockResolvedValueOnce("30");
    context.clientManager.getSocketIdsByUserInRoom.mockReturnValue([]);
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(context.redis.eval).toHaveBeenCalledTimes(2);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.MUSIC_ALREADY_PLAYING });
  });

  it("cross-instance denial: holder live only on another node (local empty, fetchSockets finds them) → denied, no steal", async () => {
    const socket = createMockSocket(20); // requester
    const context = createMockContext("room-1");
    context.redis.eval.mockResolvedValue("10"); // phase 1 returns holder
    // Local clientManager has no sockets for the holder on THIS instance…
    context.clientManager.getSocketIdsByUserInRoom.mockReturnValue([]);
    // …but the fleet-wide fetch finds the holder's socket on another node.
    context.io.in.mockReturnValue({
      fetchSockets: vi.fn().mockResolvedValue([
        { id: "remote-sock", data: { user: { id: 10 } } },
      ]),
      local: { fetchSockets: vi.fn().mockResolvedValue([]) },
    });
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(context.io.in).toHaveBeenCalledWith("room-1");
    // Live remotely → no steal (phase-2 eval must NOT run).
    expect(context.redis.eval).toHaveBeenCalledTimes(1);
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.MUSIC_ALREADY_PLAYING });
  });

  it("dead-holder steal proceeds when BOTH local and cluster show zero sockets", async () => {
    const socket = createMockSocket(20);
    const context = createMockContext("room-1");
    context.redis.eval
      .mockResolvedValueOnce("10") // phase 1: dead holder
      .mockResolvedValueOnce("20"); // phase 2 CAS: requester wins
    context.clientManager.getSocketIdsByUserInRoom.mockReturnValue([]); // local zero
    // Cluster fetch returns no socket for the holder (other participants only).
    context.io.in.mockReturnValue({
      fetchSockets: vi.fn().mockResolvedValue([
        { id: "other-listener", data: { user: { id: 99 } } },
      ]),
      local: { fetchSockets: vi.fn().mockResolvedValue([]) },
    });
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(context.redis.eval).toHaveBeenCalledTimes(2); // steal attempted
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "playing", userId: 20 }),
      context.cascadeRelay,
    );
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});

describe("audioPlayer:takeover — owner force-take", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a non-owner admin and leaves the current DJ playing", async () => {
    verifyRoomOwnerMock.mockResolvedValue({ allowed: false, error: Errors.NOT_AUTHORIZED });
    const socket = createMockSocket(20); // admin
    const { context, emitMock } = createTakeoverContext({
      clientRoomId: "room-1",
      currentPlayer: "10", // a different DJ is live
    });
    const handler = getTakeoverHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song X", duration: 150 }, cb);

    expect(verifyRoomOwnerMock).toHaveBeenCalledWith("room-1", "20", context);
    expect(context.redis.set).not.toHaveBeenCalled(); // mutex untouched
    expect(emitMock).not.toHaveBeenCalled(); // no revoke
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.NOT_AUTHORIZED });
  });

  it("owner force-takes: reassigns mutex, targets revoke at displaced DJ, broadcasts stateChanged", async () => {
    verifyRoomOwnerMock.mockResolvedValue({ allowed: true });
    const socket = createMockSocket(10); // owner
    const { context, emitMock } = createTakeoverContext({
      clientRoomId: "room-1",
      currentPlayer: "20", // displaced DJ
      displacedSocketIds: ["sock-a", "sock-b"],
    });
    const handler = getTakeoverHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Owner Song", duration: 200 }, cb);

    // Mutex force-overwritten (no NX argument).
    expect(context.redis.set).toHaveBeenCalledWith(
      "room:room-1:musicPlayer",
      "10",
      "EX",
      7200,
    );
    // Targeted revoke to the displaced DJ's sockets in this room only.
    expect(context.clientManager.getSocketIdsByUserInRoom).toHaveBeenCalledWith(20, "room-1");
    expect(context.io.to).toHaveBeenCalledWith(["sock-a", "sock-b"]);
    expect(emitMock).toHaveBeenCalledWith("audioPlayer:revoked", { roomId: "room-1", byUserId: 10 });
    // Normal now-playing broadcast.
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "playing", userId: 10, title: "Owner Song" }),
      context.cascadeRelay,
    );
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("owner takes a free slot without emitting a revoke", async () => {
    verifyRoomOwnerMock.mockResolvedValue({ allowed: true });
    const socket = createMockSocket(10); // owner
    const { context, emitMock } = createTakeoverContext({
      clientRoomId: "room-1",
      currentPlayer: null, // nobody playing
    });
    const handler = getTakeoverHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Owner Song", duration: 200 }, cb);

    expect(context.redis.set).toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled(); // no displaced DJ → no revoke
    expect(broadcastToRoomMock).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});

describe("releaseMusicPlayerForUser (renamed from clearMusicPlayerOnDisconnect — dj-talk-over/02, now shared by kick/seat-lock/shrink too)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the mutex and broadcasts stop when the disconnecting user was playing", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue("10"),
      del: vi.fn().mockResolvedValue(1),
    } as any;
    const io = {} as any;

    await releaseMusicPlayerForUser(redis, io, "room-1", 10, null);

    expect(redis.del).toHaveBeenCalledWith("room:room-1:musicPlayer");
    expect(redis.del).toHaveBeenCalledWith("room:room-1:musicState");
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId: 10 }),
      null,
    );
  });

  it("does nothing if the disconnecting user is not the current player", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue("99"),
      del: vi.fn(),
    } as any;
    const io = {} as any;

    await releaseMusicPlayerForUser(redis, io, "room-1", 10, null);

    expect(redis.del).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });
});

describe("audioPlayerLifecycle.onDisconnect — trailing-disconnect guard (music-dj-queue/01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createDisconnectCtx(opts: {
    roomId: string | null;
    /** Sockets the local clientManager reports for this user in the room. */
    localSocketIds: string[];
    /** Sockets a cross-instance fetch reports for the room. */
    remoteSockets?: Array<{ id: string; data: { user: { id: number } } }>;
    currentPlayer?: string | null;
  }) {
    const dyingSocket = { id: "dying-sock" } as any;
    const appCtx = {
      redis: {
        get: vi.fn().mockResolvedValue(opts.currentPlayer ?? "10"),
        del: vi.fn().mockResolvedValue(1),
      },
      io: {
        in: vi.fn().mockReturnValue({
          fetchSockets: vi.fn().mockResolvedValue(opts.remoteSockets ?? []),
          local: { fetchSockets: vi.fn().mockResolvedValue([]) },
        }),
      },
      clientManager: {
        getSocketIdsByUserInRoom: vi.fn().mockReturnValue(opts.localSocketIds),
      },
      cascadeRelay: null,
    } as any;
    const ctx = {
      socket: dyingSocket,
      userId: 10,
      roomId: opts.roomId,
      reason: "transport close",
    } as any;
    return { appCtx, ctx };
  }

  it("skips release when the user still has ANOTHER live socket in the room (local)", async () => {
    const { appCtx, ctx } = createDisconnectCtx({
      roomId: "room-1",
      localSocketIds: ["other-live-sock"], // a different socket of the same user
    });

    await audioPlayerLifecycle.onDisconnect(ctx, appCtx);

    // Reused mutex must survive — no read, no del, no stop broadcast.
    expect(appCtx.redis.del).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("skips release when the only other live socket is on ANOTHER instance (cross-instance)", async () => {
    const { appCtx, ctx } = createDisconnectCtx({
      roomId: "room-1",
      localSocketIds: ["dying-sock"], // only the dying socket locally → excluded
      remoteSockets: [{ id: "remote-sock", data: { user: { id: 10 } } }],
    });

    await audioPlayerLifecycle.onDisconnect(ctx, appCtx);

    expect(appCtx.io.in).toHaveBeenCalledWith("room-1");
    expect(appCtx.redis.del).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("releases as before when the user has no other live socket anywhere (regression)", async () => {
    const { appCtx, ctx } = createDisconnectCtx({
      roomId: "room-1",
      localSocketIds: ["dying-sock"], // only the dying socket → excluded
      remoteSockets: [], // nothing across the fleet
      currentPlayer: "10", // the disconnecting user was the DJ
    });

    await audioPlayerLifecycle.onDisconnect(ctx, appCtx);

    expect(appCtx.redis.del).toHaveBeenCalledWith("room:room-1:musicPlayer");
    expect(appCtx.redis.del).toHaveBeenCalledWith("room:room-1:musicState");
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      appCtx.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId: 10 }),
      null,
    );
  });

  it("no-op when the disconnect had no room (unchanged early return)", async () => {
    const { appCtx, ctx } = createDisconnectCtx({
      roomId: null,
      localSocketIds: [],
    });

    await audioPlayerLifecycle.onDisconnect(ctx, appCtx);

    expect(appCtx.clientManager.getSocketIdsByUserInRoom).not.toHaveBeenCalled();
    expect(appCtx.redis.del).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });
});
