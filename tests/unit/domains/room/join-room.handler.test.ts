import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-id",
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
  },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    INSTANCE_ID: "self",
    PUBLIC_IP: "1.2.3.4",
    PORT: 3030,
    AWS_REGION: "us-east-1",
    MEDIASOUP_ANNOUNCED_IP: null,
  },
}));

const emitToRoomMock = vi.fn();
vi.mock("@src/shared/room-emit.js", () => ({
  emitToRoom: (...args: unknown[]) => emitToRoomMock(...args),
}));

vi.mock("@src/domains/seat/index.js", () => ({
  setRoomOwner: vi.fn(),
}));

vi.mock("@src/domains/audio-player/index.js", () => ({
  getMusicPlayerState: vi.fn().mockResolvedValue(null),
}));

vi.mock("@src/domains/room/room-leave.js", () => ({
  performRoomLeave: vi.fn().mockResolvedValue(undefined),
}));

import { joinRoomHandler } from "@src/domains/room/handlers/join-room.handler.js";

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: "Test User",
    phone: "+1234567890",
    email: "test@example.com",
    date_of_birth: "1990-01-01",
    signature: "sig",
    avatar: "avatar.jpg",
    frame_id: null,
    chat_bubble_id: null,
    entry_animation_id: null,
    data_card_id: null,
    mice_wave_id: null,
    slides_id: null,
    gender: 1,
    country: "US",
    wealth_xp: "100",
    charm_xp: "50",
    vip_level: 2,
    ...overrides,
  };
}

function createMockSocket(user = makeUser()) {
  return {
    id: "socket-self",
    data: { user },
    join: vi.fn(),
  } as any;
}

function createMockContext(remoteSockets: unknown[] = []) {
  return {
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue(remoteSockets),
      }),
      sockets: { sockets: new Map() },
    },
    roomManager: {
      getRoom: vi.fn().mockReturnValue(null),
      getOrCreateRoom: vi
        .fn()
        .mockResolvedValue({ router: { rtpCapabilities: {} } }),
      state: {
        get: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        adjustParticipantCount: vi.fn().mockResolvedValue(1),
      },
    },
    clientManager: {
      getClient: vi.fn().mockReturnValue(null),
      setClientRoom: vi.fn(),
      getClientsInRoom: vi.fn().mockReturnValue([]),
    },
    seatRepository: {
      getSeats: vi.fn().mockResolvedValue([]),
    },
    cascadeCoordinator: null,
    roomRegistry: null,
    autoCloseService: {
      recordActivity: vi.fn().mockResolvedValue(undefined),
    },
    userRoomRepository: {
      setUserRoom: vi.fn().mockResolvedValue(undefined),
    },
    laravelClient: {
      updateRoomStatus: vi.fn().mockResolvedValue(undefined),
    },
    statusCoalescer: { submit: vi.fn() },
    redis: {},
    cascadeRelay: null,
  } as any;
}

describe("joinRoomHandler", () => {
  let socket: ReturnType<typeof createMockSocket>;
  let context: ReturnType<typeof createMockContext>;
  let handler: (payload: unknown, cb?: (r: unknown) => void) => Promise<void>;

  beforeEach(() => {
    socket = createMockSocket();
    context = createMockContext();
    vi.clearAllMocks();
    handler = joinRoomHandler(socket, context);
  });

  describe("room:userJoined broadcast", () => {
    it("does not include phone or email", async () => {
      await handler({ roomId: "room-1" }, vi.fn());

      expect(emitToRoomMock).toHaveBeenCalledOnce();
      const [, , , payload] = emitToRoomMock.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        { user: Record<string, unknown> },
      ];
      expect(payload.user).not.toHaveProperty("phone");
      expect(payload.user).not.toHaveProperty("email");
    });

    it("includes date_of_birth", async () => {
      await handler({ roomId: "room-1" }, vi.fn());

      const [, , , payload] = emitToRoomMock.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        { user: Record<string, unknown> },
      ];
      expect(payload.user.date_of_birth).toBe("1990-01-01");
    });
  });

  describe("join snapshot", () => {
    it("includes date_of_birth for each existing participant", async () => {
      const remoteUser = makeUser({ id: 99, date_of_birth: "1985-05-15" });
      const ctx = createMockContext([
        { id: "remote-1", data: { user: remoteUser } },
      ]);
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        participants: Array<{ date_of_birth: string | null }>;
      };
      expect(result.participants).toHaveLength(1);
      expect(result.participants[0]?.date_of_birth).toBe("1985-05-15");
    });
  });

  // Ghost-cluster guard: a pre-existing local cluster must be backed by valid
  // ownership (origin) or edge registration; otherwise it is a leftover that
  // would short-circuit ownership resolution and cause same-region split-brain.
  describe("ghost-cluster guard", () => {
    function makeGuardContext(opts: {
      owner: string | null;
      isEdgeRoom: boolean;
    }) {
      const ctx = createMockContext();
      // A leftover cluster is present locally.
      ctx.roomManager.getRoom = vi
        .fn()
        .mockReturnValue({ router: { rtpCapabilities: {} } });
      ctx.roomManager.evictLocalRoom = vi.fn().mockResolvedValue(undefined);
      ctx.roomRegistry = {
        getOwner: vi.fn().mockResolvedValue(opts.owner),
        claimOwnership: vi.fn().mockResolvedValue({ won: true, owner: "self" }),
        registerOrigin: vi.fn().mockResolvedValue(undefined),
        refreshOwnership: vi.fn().mockResolvedValue(undefined),
      };
      ctx.cascadeCoordinator = {
        isEdgeRoom: vi.fn().mockReturnValue(opts.isEdgeRoom),
        handleCrossRegionJoin: vi.fn().mockResolvedValue({ isEdge: false }),
      };
      return ctx;
    }

    it("evicts a ghost cluster when another instance owns the room and we are not an edge", async () => {
      const ctx = makeGuardContext({
        owner: "other-instance",
        isEdgeRoom: false,
      });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).toHaveBeenCalledWith("room-1");
      // After eviction it must fall through to ownership resolution (re-claim CAS).
      expect(ctx.roomRegistry.claimOwnership).toHaveBeenCalledWith(
        "room-1",
        "self",
      );
    });

    it("evicts a ghost cluster when the ownership key is expired/unset and we are not an edge", async () => {
      const ctx = makeGuardContext({ owner: null, isEdgeRoom: false });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).toHaveBeenCalledWith("room-1");
    });

    it("keeps the cluster (no eviction) when this instance owns the room", async () => {
      const ctx = makeGuardContext({ owner: "self", isEdgeRoom: false });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).not.toHaveBeenCalled();
      // Owns it → no re-CAS churn.
      expect(ctx.roomRegistry.claimOwnership).not.toHaveBeenCalled();
    });

    it("keeps the cluster (no eviction) when this instance is a registered edge", async () => {
      const ctx = makeGuardContext({
        owner: "other-instance",
        isEdgeRoom: true,
      });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).not.toHaveBeenCalled();
    });
  });
});
