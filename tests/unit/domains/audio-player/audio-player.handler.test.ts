import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("releases + broadcasts stop when the disconnecting user was playing (queue empty → no grant)", async () => {
    // music-dj-queue/04: release now runs RELEASE_AND_GRANT_LUA (get+del → eval).
    // Empty queue → 'released' with head '' → no grant emission.
    const redis = {
      eval: vi.fn().mockResolvedValue(["released", ""]),
    } as any;
    const io = { to: vi.fn(), in: vi.fn() } as any;

    await releaseMusicPlayerForUser(redis, io, "room-1", 10, null);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      "room:room-1:musicPlayer",
      "room:room-1:musicState",
      "room:room-1:musicQueue",
      "10",
      "15", // provisional grace TTL for the head grant
    );
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId: 10 }),
      null,
    );
    expect(io.to).not.toHaveBeenCalled(); // no waiter → no grant
  });

  it("does nothing if the disconnecting user is not the current player ('denied' no-op)", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(["denied", "99"]),
    } as any;
    const io = { to: vi.fn(), in: vi.fn() } as any;

    await releaseMusicPlayerForUser(redis, io, "room-1", 10, null);

    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
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
        // music-dj-queue/04: release runs RELEASE_AND_GRANT_LUA. Default: the
        // disconnecting user IS the holder and the queue is empty → 'released'/''.
        eval: vi.fn().mockResolvedValue(["released", ""]),
        // music-dj-queue/05: disconnect also LREMs the user from the waiting queue.
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

    // Reused mutex must survive — no release eval, no stop broadcast.
    expect(appCtx.redis.eval).not.toHaveBeenCalled();
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
    expect(appCtx.redis.eval).not.toHaveBeenCalled();
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

    // Release now runs RELEASE_AND_GRANT_LUA (the DELs happen inside Lua).
    expect(appCtx.redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      "room:room-1:musicPlayer",
      "room:room-1:musicState",
      "room:room-1:musicQueue",
      "10",
      "15",
    );
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
    expect(appCtx.redis.eval).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  // music-dj-queue/05: a disconnecting user who is truly gone from the room is
  // also LREM'd from the waiting queue (before the release), so a queued admin
  // who closed the tab does not linger in line.
  it("(05-7) dying waiter with no other live socket → LREM'd from the queue BEFORE the release", async () => {
    const { appCtx, ctx } = createDisconnectCtx({
      roomId: "room-1",
      localSocketIds: ["dying-sock"], // only the dying socket → excluded → gone
      remoteSockets: [],
    });

    await audioPlayerLifecycle.onDisconnect(ctx, appCtx);

    expect(appCtx.redis.lrem).toHaveBeenCalledWith("room:room-1:musicQueue", 0, "10");
    // Ordering guarantee: dequeue runs before the release eval.
    expect(appCtx.redis.lrem.mock.invocationCallOrder[0]).toBeLessThan(
      appCtx.redis.eval.mock.invocationCallOrder[0],
    );
  });

  it("(05-7b) still has another live socket in the room → early return, no LREM, no release", async () => {
    const { appCtx, ctx } = createDisconnectCtx({
      roomId: "room-1",
      localSocketIds: ["other-live-sock"], // a different live socket of the same user
    });

    await audioPlayerLifecycle.onDisconnect(ctx, appCtx);

    expect(appCtx.redis.lrem).not.toHaveBeenCalled();
    expect(appCtx.redis.eval).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// music-dj-queue/04 — DJ waiting queue: enqueue → grant → auto-start
// ─────────────────────────────────────────────────────────────────

/**
 * In-memory emulation of the four music Lua scripts against a shared
 * {holder, queue} state, dispatched by a unique substring of each script. This
 * exercises each script's *contract* (idempotent enqueue, atomic release+grant,
 * promote-if-free, reuse-if-mine acquire) without a real Redis — the same seam
 * the ticket-01 tests use for `redis.eval`.
 */
function makeFakeMusicRedis(initial: { holder?: string | null; queue?: string[] }) {
  const state: { holder: string | null; queue: string[] } = {
    holder: initial.holder ?? null,
    queue: [...(initial.queue ?? [])],
  };
  const evalFn = vi.fn(
    async (script: string, numKeys: number, ...rest: string[]) => {
      const argv = rest.slice(numKeys); // drop the KEYS, keep ARGV

      if (script.includes("LPOS")) {
        // ENQUEUE_MUSIC_WAITER_LUA — idempotent per user; 1-based position.
        const uid = argv[0]!;
        const idx = state.queue.indexOf(uid);
        if (idx >= 0) return idx + 1;
        state.queue.push(uid);
        return state.queue.length;
      }
      if (script.includes("'released'")) {
        // RELEASE_AND_GRANT_LUA — compare, pop head, set/del in one shot.
        const releasing = argv[0]!;
        if (state.holder !== releasing) return ["denied", state.holder ?? ""];
        const head = state.queue.shift() ?? null;
        state.holder = head; // provisional grant hold, or free when null
        return ["released", head ?? ""];
      }
      if (script.includes("EXISTS")) {
        // PROMOTE_IF_FREE_LUA — grant head only when the slot is free.
        if (state.holder) return "";
        const head = state.queue.shift() ?? null;
        if (head) state.holder = head;
        return head ?? "";
      }
      // ACQUIRE_MUSIC_SLOT_LUA — free / reuse-if-mine / CAS-steal.
      const me = argv[0]!;
      const steal = argv[1]!;
      const cur = state.holder;
      if (!cur || cur === me || (steal !== "" && cur === steal)) {
        state.holder = me;
        return me;
      }
      return cur;
    },
  );
  return { state, evalFn };
}

/** Context with the fake music-redis, a chainable `io.to().emit()`, and a
 *  per-user room-scoped socket lookup for grant targeting. */
function createQueueContext(opts: {
  clientRoomId: string | null;
  holder?: string | null;
  queue?: string[];
  socketIdsByUser?: Record<number, string[]>;
  remoteSockets?: Array<{ id: string; data: { user: { id: number } } }>;
}) {
  const fake = makeFakeMusicRedis({ holder: opts.holder, queue: opts.queue });
  const emitMock = vi.fn();
  const context = {
    clientManager: {
      getClient: vi.fn().mockReturnValue(opts.clientRoomId ? { roomId: opts.clientRoomId } : null),
      getSocketIdsByUserInRoom: vi.fn((uid: number) => opts.socketIdsByUser?.[uid] ?? []),
    },
    redis: {
      eval: fake.evalFn,
      setex: vi.fn().mockResolvedValue("OK"),
      // music-dj-queue/05: model get/set on the player key against the shared
      // fake state so takeover (which writes the mutex directly, not via Lua)
      // stays coherent with a subsequent stop's release. Other keys → null/OK.
      set: vi.fn(async (key: string, val: string) => {
        if (key.endsWith(":musicPlayer")) fake.state.holder = String(val);
        return "OK";
      }),
      get: vi.fn(async (key: string) =>
        key.endsWith(":musicPlayer") ? fake.state.holder : null,
      ),
      del: vi.fn().mockResolvedValue(1),
      // music-dj-queue/05: LREM against the fake queue (leaveQueue uses a plain
      // command, not Lua). Returns the removed count.
      lrem: vi.fn(async (_key: string, _count: number, val: string) => {
        const idx = fake.state.queue.indexOf(String(val));
        if (idx < 0) return 0;
        fake.state.queue.splice(idx, 1);
        return 1;
      }),
    },
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue(opts.remoteSockets ?? []),
        local: { fetchSockets: vi.fn().mockResolvedValue([]) },
      }),
      to: vi.fn().mockReturnValue({ emit: emitMock }),
    },
    cascadeRelay: null,
  } as any;
  return { context, emitMock, state: fake.state };
}

function getStopHandler(socket: any, context: any) {
  audioPlayerHandler(socket, context);
  const call = socket.on.mock.calls.find(([event]: [string]) => event === "audioPlayer:stop");
  return call[1];
}

function getLeaveQueueHandler(socket: any, context: any) {
  audioPlayerHandler(socket, context);
  const call = socket.on.mock.calls.find(([event]: [string]) => event === "audioPlayer:leaveQueue");
  return call[1];
}

/** Count the targeted `audioPlayer:granted` emits recorded by an io.to().emit spy. */
function grantedEmits(emitMock: ReturnType<typeof vi.fn>) {
  return emitMock.mock.calls.filter(([event]: [string]) => event === "audioPlayer:granted");
}

describe("audioPlayer:play — waiting queue enqueue (music-dj-queue/04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  });

  it("(1) denial + enqueue:true → queued ack with position 1, no play broadcast", async () => {
    const socket = createMockSocket(20);
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      socketIdsByUser: { 10: ["holder-live"] }, // live holder → genuine denial
    });
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song", duration: 120, enqueue: true }, cb);

    expect(cb).toHaveBeenCalledWith({
      success: false,
      error: Errors.MUSIC_ALREADY_PLAYING,
      queued: true,
      position: 1,
    });
    expect(state.queue).toEqual(["20"]); // enqueued at the tail
    expect(state.holder).toBe("10"); // live DJ keeps the slot
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });

  it("(2) idempotent re-play while queued → same position, no duplicate entry", async () => {
    const socket = createMockSocket(20);
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      socketIdsByUser: { 10: ["holder-live"] },
    });
    const handler = getPlayHandler(socket, context);

    const cb1 = vi.fn();
    await handler({ roomId: "room-1", title: "Song", duration: 120, enqueue: true }, cb1);
    const cb2 = vi.fn();
    await handler({ roomId: "room-1", title: "Song", duration: 120, enqueue: true }, cb2);

    expect(cb1).toHaveBeenCalledWith(expect.objectContaining({ queued: true, position: 1 }));
    expect(cb2).toHaveBeenCalledWith(expect.objectContaining({ queued: true, position: 1 }));
    expect(state.queue).toEqual(["20"]); // still ONE entry
  });

  it("(3) denial WITHOUT the enqueue flag → plain MUSIC_ALREADY_PLAYING, no queue write (OTA compat)", async () => {
    const socket = createMockSocket(20);
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      socketIdsByUser: { 10: ["holder-live"] },
    });
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    // Old bundles omit `enqueue` — zod defaults it to false.
    await handler({ roomId: "room-1", title: "Song", duration: 120 }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.MUSIC_ALREADY_PLAYING });
    expect(state.queue).toEqual([]); // never enqueued
  });

  it("(8) promote-if-free: slot freed between denial and enqueue → promoted, success:true", async () => {
    const socket = createMockSocket(20);
    // Holder present at acquire time (denial), but the fake frees the slot just
    // before promote so the enqueuer is promoted as the head.
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      socketIdsByUser: { 10: ["holder-live"] },
    });
    // Drop the holder right after the (denying) acquire eval, before promote runs.
    let acquireSeen = false;
    const realEval = context.redis.eval;
    context.redis.eval = vi.fn(async (script: string, ...args: any[]) => {
      const out = await realEval(script, ...args);
      if (!script.includes("LPOS") && !script.includes("'released'") && !script.includes("EXISTS") && !acquireSeen) {
        acquireSeen = true;
        state.holder = null; // the live DJ released in the race window
      }
      return out;
    });
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song", duration: 120, enqueue: true }, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    expect(state.holder).toBe("20"); // enqueuer now holds the slot
    expect(state.queue).toEqual([]); // popped as the head
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "playing", userId: 20 }),
      context.cascadeRelay,
    );
  });

  it("(8b) promote-win but reacquire lost (owner takeover in the window) → plain denial, no playing broadcast", async () => {
    const socket = createMockSocket(20);
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      socketIdsByUser: { 10: ["holder-live"], 99: ["owner-live"] },
    });
    // Free the slot after the denying acquire (so promote wins for 20), then let
    // the owner force-overwrite the key after the promote but BEFORE the
    // TTL-refresh reacquire — the reacquire must lose and the handler must deny.
    let acquireSeen = false;
    const realEval = context.redis.eval;
    context.redis.eval = vi.fn(async (script: string, ...args: any[]) => {
      const out = await realEval(script, ...args);
      const isAcquire = !script.includes("LPOS") && !script.includes("'released'") && !script.includes("EXISTS");
      if (isAcquire && !acquireSeen) {
        acquireSeen = true;
        state.holder = null; // released in the race window → promote will win
      }
      if (script.includes("EXISTS")) {
        state.holder = "99"; // owner takeover snipes the just-promoted slot
      }
      return out;
    });
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song", duration: 120, enqueue: true }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.MUSIC_ALREADY_PLAYING });
    expect(state.holder).toBe("99"); // owner keeps the slot untouched
    expect(context.redis.setex).not.toHaveBeenCalled(); // no musicState write
    expect(broadcastToRoomMock).not.toHaveBeenCalled(); // no phantom "playing"
  });
});

describe("audioPlayer:stop / release — grant on release (music-dj-queue/04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  });

  it("(4) stop by holder with a waiter → released, stop broadcast, targeted grant, provisional hold set", async () => {
    const socket = createMockSocket(10); // the holder stops
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20"],
      socketIdsByUser: { 20: ["waiter-sock"] }, // waiter is local → fast path
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    // Released + stop broadcast.
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId: 10 }),
      context.cascadeRelay,
    );
    // Provisional grant: the head now holds the slot (grace TTL), queue drained.
    expect(state.holder).toBe("20");
    expect(state.queue).toEqual([]);
    // Targeted grant emitted to the waiter's room-scoped socket only.
    expect(context.clientManager.getSocketIdsByUserInRoom).toHaveBeenCalledWith(20, "room-1");
    expect(context.io.to).toHaveBeenCalledWith(["waiter-sock"]);
    expect(emitMock).toHaveBeenCalledWith("audioPlayer:granted", { roomId: "room-1" });
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("(6) stop by a non-holder → NOT_AUTHORIZED, queue untouched, no grant", async () => {
    const socket = createMockSocket(99); // not the holder
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20"],
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.NOT_AUTHORIZED });
    expect(state.holder).toBe("10"); // untouched
    expect(state.queue).toEqual(["20"]); // untouched
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("(5) releaseMusicPlayerForUser (disconnect/kick path) with a waiter → grant emitted fleet-wide", async () => {
    // No clientManager in this helper's signature → fetchSocketsSafe-only targeting.
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20"],
      remoteSockets: [{ id: "waiter-remote", data: { user: { id: 20 } } }],
    });

    await releaseMusicPlayerForUser(context.redis, context.io, "room-1", 10, null);

    expect(state.holder).toBe("20"); // provisional grant to the head
    expect(state.queue).toEqual([]);
    expect(broadcastToRoomMock).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId: 10 }),
      null,
    );
    // Grantee found via the room fetch (no clientManager here), targeted by socket id.
    expect(context.io.in).toHaveBeenCalledWith("room-1");
    expect(context.io.to).toHaveBeenCalledWith(["waiter-remote"]);
    expect(emitMock).toHaveBeenCalledWith("audioPlayer:granted", { roomId: "room-1" });
  });

  it("(9) fleet-wide grant targeting: clientManager local-miss falls back to fetchSockets, waiter sockets only", async () => {
    const socket = createMockSocket(10); // holder stops
    const { context, emitMock } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20"],
      socketIdsByUser: {}, // local miss for the waiter
      remoteSockets: [
        { id: "waiter-remote", data: { user: { id: 20 } } },
        { id: "bystander", data: { user: { id: 77 } } }, // must NOT be targeted
      ],
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(context.io.in).toHaveBeenCalledWith("room-1"); // fell back to fetchSockets
    expect(context.io.to).toHaveBeenCalledWith(["waiter-remote"]); // filtered to the waiter
    expect(emitMock).toHaveBeenCalledWith("audioPlayer:granted", { roomId: "room-1" });
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});

describe("audioPlayer:takeover — queue preserved (music-dj-queue/04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomOwnerMock.mockResolvedValue({ allowed: true });
  });

  it("(7) owner takeover with waiters → queue untouched, no grant emitted", async () => {
    const socket = createMockSocket(10); // owner
    const { context, emitMock } = createTakeoverContext({
      clientRoomId: "room-1",
      currentPlayer: "20", // displaced DJ
      displacedSocketIds: ["displaced-sock"],
    });
    // Takeover reads/writes the mutex directly (get/set), never the queue — assert
    // the queue LIST is never touched (no eval, no LPOP) and only a revoke fires.
    context.redis.eval = vi.fn();
    const handler = getTakeoverHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Owner", duration: 200 }, cb);

    expect(context.redis.eval).not.toHaveBeenCalled(); // queue never consulted
    // Only the targeted revoke to the displaced DJ — never a grant.
    expect(emitMock).toHaveBeenCalledWith("audioPlayer:revoked", { roomId: "room-1", byUserId: 10 });
    expect(emitMock).not.toHaveBeenCalledWith("audioPlayer:granted", expect.anything());
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});

// ─────────────────────────────────────────────────────────────────
// music-dj-queue/05 — queue edge cases: cancel, ghost-skip, grace, takeover
// ─────────────────────────────────────────────────────────────────

describe("audioPlayer:leaveQueue — cancel a waiting spot (music-dj-queue/05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1) removes a queued waiter → { success: true, removed: true }, queue updated", async () => {
    const socket = createMockSocket(20);
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20", "30"],
    });
    const handler = getLeaveQueueHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(context.redis.lrem).toHaveBeenCalledWith("room:room-1:musicQueue", 0, "20");
    expect(cb).toHaveBeenCalledWith({ success: true, removed: true });
    expect(state.queue).toEqual(["30"]); // only the caller pulled out
  });

  it("(1b) not-queued user → removed: false, queue untouched", async () => {
    const socket = createMockSocket(99);
    const { context, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20"],
    });
    const handler = getLeaveQueueHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: true, removed: false });
    expect(state.queue).toEqual(["20"]);
  });

  it("(1c) rejects when the caller is not in the room (in-room GATE)", async () => {
    const socket = createMockSocket(20);
    const { context } = createQueueContext({ clientRoomId: "other-room", queue: ["20"] });
    const handler = getLeaveQueueHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(context.redis.lrem).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.NOT_IN_ROOM });
  });
});

describe("audioPlayer:stop — ghost-skip grant chain (music-dj-queue/05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  });

  it("(2) dead head + live second waiter → chain skips the ghost, grants the live waiter, exactly one grant", async () => {
    const socket = createMockSocket(10); // holder stops
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20", "30"], // 20 is a ghost (no sockets), 30 is live locally
      socketIdsByUser: { 30: ["live-30"] },
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    // Ghost head 20 popped+released inside the chain; live 30 becomes the holder.
    expect(state.holder).toBe("30");
    expect(state.queue).toEqual([]);
    expect(context.io.to).toHaveBeenCalledWith(["live-30"]);
    expect(grantedEmits(emitMock)).toHaveLength(1); // exactly one grant emit
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("(3) ALL waiters dead → queue drained, slot freed (holder null), zero grants", async () => {
    const socket = createMockSocket(10);
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20", "30"], // both ghosts (no sockets anywhere)
      socketIdsByUser: {},
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(state.holder).toBeNull(); // slot released, nobody live to grant
    expect(state.queue).toEqual([]); // fully drained
    expect(grantedEmits(emitMock)).toHaveLength(0);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("(8) mid-chain 'denied' (slot grabbed while skipping) → chain stops, no further pops", async () => {
    const socket = createMockSocket(10);
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20", "30"],
      socketIdsByUser: {}, // 20 reads dead locally…
    });
    // …but a rival acquires the freed slot during 20's cross-instance liveness
    // fetch: the fetch resolves empty yet flips the holder, so the next
    // releaseAndGrant sees a mismatch and returns 'denied' → the chain must stop.
    context.io.in = vi.fn().mockReturnValue({
      fetchSockets: vi.fn(async () => {
        state.holder = "99";
        return [];
      }),
      local: { fetchSockets: vi.fn().mockResolvedValue([]) },
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(state.holder).toBe("99"); // rival keeps the slot, untouched
    expect(state.queue).toEqual(["30"]); // 30 never popped (chain stopped at denial)
    expect(grantedEmits(emitMock)).toHaveLength(0);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});

describe("audioPlayer grace-expiry advance (music-dj-queue/05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(4) silent grantee → grace timer promotes + grants the next waiter", async () => {
    vi.useFakeTimers();
    const socket = createMockSocket(10);
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20", "30"],
      socketIdsByUser: { 20: ["live-20"], 30: ["live-30"] },
      // The grace timer's grantChain runs WITHOUT clientManager (io+redis only),
      // so it resolves 30's liveness via the fleet fetch — 30 must appear there.
      remoteSockets: [{ id: "live-30", data: { user: { id: 30 } } }],
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    // Head 20 granted, provisional hold set, timer armed. One grant so far.
    expect(state.holder).toBe("20");
    expect(context.io.to).toHaveBeenCalledWith(["live-20"]);
    expect(grantedEmits(emitMock)).toHaveLength(1);

    // 20 stays silent: their 15s provisional hold expires (emulate by clearing
    // the holder in the fake) — then the grace timer fires past (grace+1)s.
    state.holder = null;
    await vi.advanceTimersByTimeAsync((15 + 1) * 1000);

    // promoteIfFree popped 30 (slot was free) and granted it to them.
    expect(state.holder).toBe("30");
    expect(state.queue).toEqual([]);
    expect(grantedEmits(emitMock)).toHaveLength(2);
    expect(context.io.to).toHaveBeenLastCalledWith(["live-30"]);
  });

  it("(5) grantee played (holder still set) → grace timer is a no-op, no second grant", async () => {
    vi.useFakeTimers();
    const socket = createMockSocket(10);
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "10",
      queue: ["20"],
      socketIdsByUser: { 20: ["live-20"] },
    });
    const handler = getStopHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1" }, cb);

    expect(state.holder).toBe("20"); // granted, provisional hold
    expect(grantedEmits(emitMock)).toHaveLength(1);

    // 20 played → their play refreshed the mutex, so the holder stays "20".
    await vi.advanceTimersByTimeAsync((15 + 1) * 1000);

    // promoteIfFree sees EXISTS → no-op. Holder untouched, no second grant.
    expect(state.holder).toBe("20");
    expect(grantedEmits(emitMock)).toHaveLength(1);
  });
});

describe("audioPlayer:takeover then stop — queue preserved, release serves (music-dj-queue/05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRoomOwnerMock.mockResolvedValue({ allowed: true });
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
  });

  it("(6) owner takeover preserves the queue behind them; the owner's stop grants the head", async () => {
    const socket = createMockSocket(10); // owner
    const { context, emitMock, state } = createQueueContext({
      clientRoomId: "room-1",
      holder: "20", // displaced DJ currently playing
      queue: ["30"], // a waiter behind them
      socketIdsByUser: { 20: ["displaced-sock"], 30: ["live-30"] },
    });

    // Owner force-takes: displaced 20 revoked, mutex → owner, queue untouched.
    const takeover = getTakeoverHandler(socket, context);
    await takeover({ roomId: "room-1", title: "Owner", duration: 200 }, vi.fn());

    expect(state.holder).toBe("10"); // owner now holds (direct set)
    expect(state.queue).toEqual(["30"]); // queue preserved behind the owner
    expect(emitMock).toHaveBeenCalledWith("audioPlayer:revoked", { roomId: "room-1", byUserId: 10 });
    expect(grantedEmits(emitMock)).toHaveLength(0); // takeover never grants

    // Owner stops → the release serves the preserved head.
    const stop = getStopHandler(socket, context);
    const cb = vi.fn();
    await stop({ roomId: "room-1" }, cb);

    expect(state.holder).toBe("30"); // head granted the freed slot
    expect(state.queue).toEqual([]);
    expect(context.io.to).toHaveBeenCalledWith(["live-30"]);
    expect(grantedEmits(emitMock)).toHaveLength(1);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});

