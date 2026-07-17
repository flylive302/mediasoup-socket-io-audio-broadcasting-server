import { beforeEach, describe, expect, it, vi } from "vitest";

// room-battery-perf/05: seat-count authority. The joiner's payload seatCount is
// applied ONLY by the room-establishing first join (state source "default");
// afterwards room state is authoritative and a stale joiner is a logged no-op.

vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-id",
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@src/infrastructure/logger.js", () => ({ logger: loggerMock }));

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
    SEAT_RETENTION_GRACE_MS: 45_000,
    DEFAULT_SEAT_COUNT: 15,
  },
}));

vi.mock("@src/shared/room-emit.js", () => ({ emitToRoom: vi.fn() }));
vi.mock("@src/domains/seat/index.js", () => ({ setRoomOwner: vi.fn() }));
vi.mock("@src/domains/audio-player/index.js", () => ({
  getMusicPlayerState: vi.fn().mockResolvedValue(null),
}));
vi.mock("@src/domains/room/room-leave.js", () => ({
  performRoomLeave: vi.fn().mockResolvedValue(undefined),
}));

import { joinRoomHandler } from "@src/domains/room/handlers/join-room.handler.js";

function createMockSocket() {
  return {
    id: "socket-self",
    data: {
      user: {
        id: 42,
        name: "Test User",
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
        date_of_birth: null,
      },
    },
    join: vi.fn(),
  } as any;
}

function createMockContext(state: Record<string, unknown> | null) {
  return {
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue([]),
      }),
      sockets: { sockets: new Map() },
    },
    roomManager: {
      getRoom: vi.fn().mockReturnValue(null),
      getOrCreateRoom: vi
        .fn()
        .mockResolvedValue({ router: { rtpCapabilities: {} } }),
      state: {
        get: vi.fn().mockResolvedValue(state),
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
      reclaimSeat: vi.fn().mockResolvedValue({ reclaimed: false }),
    },
    cascadeCoordinator: null,
    roomRegistry: null,
    autoCloseService: { recordActivity: vi.fn().mockResolvedValue(undefined) },
    userRoomRepository: { setUserRoom: vi.fn().mockResolvedValue(undefined) },
    laravelClient: { updateRoomStatus: vi.fn().mockResolvedValue(undefined) },
    statusCoalescer: { submit: vi.fn() },
    redis: {},
    cascadeRelay: null,
  } as any;
}

describe("join seat-count authority (room-battery-perf/05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first join (state source 'default') establishes the room's seatCount from the payload", async () => {
    const context = createMockContext({
      id: "room-1",
      seatCount: 15,
      seatCountSource: "default",
      participantCount: 0,
    });
    const handler = joinRoomHandler(createMockSocket(), context);

    await handler({ roomId: "room-1", seatCount: 20 }, vi.fn());

    expect(context.roomManager.state.save).toHaveBeenCalledWith(
      expect.objectContaining({ seatCount: 20, seatCountSource: "client" }),
    );
    expect(context.seatRepository.getSeats).toHaveBeenCalledWith("room-1", 20);
  });

  it("a later join with a different seatCount is a no-op on state and logs the mismatch", async () => {
    const context = createMockContext({
      id: "room-1",
      seatCount: 20,
      seatCountSource: "client",
      participantCount: 3,
    });
    const handler = joinRoomHandler(createMockSocket(), context);

    await handler({ roomId: "room-1", seatCount: 15 }, vi.fn());

    expect(context.roomManager.state.save).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        requestedSeatCount: 15,
        authoritativeSeatCount: 20,
      }),
      "Joiner seatCount mismatch ignored — room state is authoritative",
    );
    // The join proceeds using the AUTHORITATIVE count, not the stale payload.
    expect(context.seatRepository.getSeats).toHaveBeenCalledWith("room-1", 20);
  });

  it("a legacy state key without seatCountSource is locked (stale joiner cannot shrink it)", async () => {
    const context = createMockContext({
      id: "room-1",
      seatCount: 25,
      participantCount: 2,
    });
    const handler = joinRoomHandler(createMockSocket(), context);

    await handler({ roomId: "room-1", seatCount: 15 }, vi.fn());

    expect(context.roomManager.state.save).not.toHaveBeenCalled();
    expect(context.seatRepository.getSeats).toHaveBeenCalledWith("room-1", 25);
  });

  it("a matching later join neither writes state nor warns", async () => {
    const context = createMockContext({
      id: "room-1",
      seatCount: 20,
      seatCountSource: "laravel",
      participantCount: 3,
    });
    const handler = joinRoomHandler(createMockSocket(), context);

    await handler({ roomId: "room-1", seatCount: 20 }, vi.fn());

    expect(context.roomManager.state.save).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Joiner seatCount mismatch ignored — room state is authoritative",
    );
  });

  it("falls back to the payload count when no room state exists (degraded path)", async () => {
    const context = createMockContext(null);
    const handler = joinRoomHandler(createMockSocket(), context);

    await handler({ roomId: "room-1", seatCount: 18 }, vi.fn());

    expect(context.roomManager.state.save).not.toHaveBeenCalled();
    expect(context.seatRepository.getSeats).toHaveBeenCalledWith("room-1", 18);
  });
});
