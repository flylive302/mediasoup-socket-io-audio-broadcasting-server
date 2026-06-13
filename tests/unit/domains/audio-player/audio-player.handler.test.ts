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
vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: (...args: unknown[]) => verifyRoomManagerMock(...args),
}));

import {
  audioPlayerHandler,
  clearMusicPlayerOnDisconnect,
} from "@src/domains/audio-player/audio-player.handler.js";
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
    },
    redis: {
      set: vi.fn().mockResolvedValue("OK"),
      setex: vi.fn().mockResolvedValue("OK"),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    },
    io: {},
    cascadeRelay: null,
  } as any;
}

function getPlayHandler(socket: any, context: any) {
  audioPlayerHandler(socket, context);
  const call = socket.on.mock.calls.find(([event]: [string]) => event === "audioPlayer:play");
  return call[1];
}

describe("audioPlayer:play — MSAB play role gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owner acquires a free slot", async () => {
    verifyRoomManagerMock.mockResolvedValue({ allowed: true });
    const socket = createMockSocket(10);
    const context = createMockContext("room-1");
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song A", duration: 180 }, cb);

    expect(verifyRoomManagerMock).toHaveBeenCalledWith("room-1", "10", context);
    expect(context.redis.set).toHaveBeenCalledWith(
      "room:room-1:musicPlayer",
      "10",
      "EX",
      7200,
      "NX",
    );
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
    const handler = getPlayHandler(socket, context);

    const cb = vi.fn();
    await handler({ roomId: "room-1", title: "Song B", duration: 200 }, cb);

    expect(verifyRoomManagerMock).toHaveBeenCalledWith("room-1", "20", context);
    expect(context.redis.set).toHaveBeenCalledWith(
      "room:room-1:musicPlayer",
      "20",
      "EX",
      7200,
      "NX",
    );
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
    expect(context.redis.set).not.toHaveBeenCalled();
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
    expect(context.redis.set).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.NOT_IN_ROOM });
  });
});

describe("clearMusicPlayerOnDisconnect (unchanged)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the mutex and broadcasts stop when the disconnecting user was playing", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue("10"),
      del: vi.fn().mockResolvedValue(1),
    } as any;
    const io = {} as any;

    await clearMusicPlayerOnDisconnect(redis, io, "room-1", 10, null);

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

    await clearMusicPlayerOnDisconnect(redis, io, "room-1", 10, null);

    expect(redis.del).not.toHaveBeenCalled();
    expect(broadcastToRoomMock).not.toHaveBeenCalled();
  });
});
