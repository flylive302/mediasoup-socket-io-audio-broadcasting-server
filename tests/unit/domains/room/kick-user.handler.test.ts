import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-correlation-id",
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    AWS_REGION: "us-east-1",
    PUBLIC_IP: null,
    MEDIASOUP_ANNOUNCED_IP: null,
    PORT: 3000,
  },
}));

const emitToRoomMock = vi.fn();
vi.mock("@src/shared/room-emit.js", () => ({
  emitToRoom: (...args: unknown[]) => emitToRoomMock(...args),
}));

vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@src/domains/seat/vip.guard.js", () => ({
  isVipAntiKickProtected: vi.fn(async () => false),
}));

import { kickUserHandler } from "@src/domains/room/handlers/kick-user.handler.js";

function createMockSocket() {
  return {
    data: { user: { id: 1 } },
  } as any;
}

function createMockContext() {
  const remoteSocketFactory = (id: string) => ({
    id,
    data: { user: { id: "42" } },
    emit: vi.fn(),
    leave: vi.fn(),
  });

  return {
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi
          .fn()
          .mockResolvedValue([remoteSocketFactory("sock-1"), remoteSocketFactory("sock-2")]),
      }),
    },
    seatRepository: {
      leaveSeat: vi.fn().mockResolvedValue({ success: false }),
    },
    clientManager: {
      getClient: vi.fn().mockReturnValue({ id: "local-client" }),
      clearClientRoom: vi.fn(),
    },
    roomManager: {
      state: {
        adjustParticipantCount: vi.fn().mockResolvedValue(5),
      },
    },
    userRoomRepository: {
      clearUserRoom: vi.fn().mockResolvedValue(undefined),
    },
    userSocketRepository: {
      getSocketIds: vi.fn().mockResolvedValue([]),
    },
    laravelClient: {
      updateRoomStatus: vi.fn().mockResolvedValue(undefined),
    },
    cascadeRelay: {},
  } as any;
}

describe("kickUserHandler", () => {
  let socket: any;
  let context: any;
  let handler: (payload: unknown, callback?: (result: any) => void) => Promise<void>;

  beforeEach(() => {
    socket = createMockSocket();
    context = createMockContext();
    vi.clearAllMocks();
    handler = kickUserHandler(socket, context);
  });

  it("adjusts participant count by removed sockets", async () => {
    const cb = vi.fn();
    await handler({ roomId: "room-1", userId: 42 }, cb);

    expect(context.roomManager.state.adjustParticipantCount).toHaveBeenCalledWith("room-1", -2);
    expect(context.userRoomRepository.clearUserRoom).toHaveBeenCalledWith(42);
    expect(emitToRoomMock).toHaveBeenCalledWith(
      socket,
      "room-1",
      "room:userLeft",
      { userId: 42 },
      context.cascadeRelay,
    );
    expect(cb).toHaveBeenCalledWith({ success: true });
  });
});
