import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config + logger BEFORE importing the handler — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
vi.mock("@src/config/index.js", () => ({ config: { DEFAULT_SEAT_COUNT: 15 } }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
  },
}));

vi.mock("@src/shared/room-emit.js", () => ({
  emitToRoom: vi.fn(),
}));

const fetchSocketsSafeMock = vi.fn();
vi.mock("@src/shared/fetch-sockets-safe.js", () => ({
  fetchSocketsSafe: (...args: unknown[]) => fetchSocketsSafeMock(...args),
}));

import { takeSeatHandler } from "@src/domains/seat/handlers/take-seat.handler.js";
import { Errors } from "@src/shared/errors.js";

// Seat-desync self-heal: a SEAT_TAKEN rejection carries the authoritative
// occupant so a client whose local view wrongly shows the seat empty can
// repair itself (there is no periodic seat resync to correct it otherwise).

function makeContext(opts: {
  takeResult: { success: boolean; error?: string };
  seats?: { index: number; userId: string | null; muted: boolean; locked: boolean; reserved?: boolean }[];
}) {
  return {
    roomManager: { state: { get: vi.fn().mockResolvedValue({ seatCount: 15 }) } },
    seatRepository: {
      takeSeat: vi.fn().mockResolvedValue(opts.takeResult),
      getSeats: vi.fn().mockResolvedValue(opts.seats ?? []),
    },
    autoCloseService: { recordActivity: vi.fn().mockResolvedValue(undefined) },
    cascadeRelay: null,
    io: {},
  };
}

const socket = { data: { user: { id: 42 } }, nsp: {} };

const occupantUser = {
  id: 7,
  name: "Occupant",
  signature: "",
  avatar: "a.png",
  frame_id: null,
  chat_bubble_id: null,
  entry_animation_id: null,
  data_card_id: null,
  mice_wave_id: null,
  slides_id: null,
  gender: 1,
  country: "PK",
  wealth_xp: "0",
  charm_xp: "0",
  vip_level: 2,
  date_of_birth: null,
  equipped_badges: [],
  phone: "+920000000000",
  email: "x@y.z",
};

describe("takeSeatHandler SEAT_TAKEN self-heal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the authoritative occupant (with live user, sans phone/email) on SEAT_TAKEN", async () => {
    const context = makeContext({
      takeResult: { success: false, error: Errors.SEAT_TAKEN },
      seats: [{ index: 6, userId: "7", muted: true, locked: false }],
    });
    fetchSocketsSafeMock.mockResolvedValue([{ data: { user: occupantUser } }]);

    const h = takeSeatHandler(socket as never, context as never);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 6 }, ack);

    const response = ack.mock.calls[0]![0];
    expect(response.success).toBe(false);
    expect(response.occupant).toMatchObject({
      seatIndex: 6,
      userId: 7,
      isMuted: true,
    });
    expect(response.occupant.user).toMatchObject({ id: 7, name: "Occupant" });
    expect(response.occupant.user).not.toHaveProperty("phone");
    expect(response.occupant.user).not.toHaveProperty("email");
  });

  it("returns occupant:null for a RESERVED (grace-held) seat — clients correctly render it empty", async () => {
    const context = makeContext({
      takeResult: { success: false, error: Errors.SEAT_TAKEN },
      seats: [{ index: 6, userId: "7", muted: false, locked: false, reserved: true }],
    });

    const h = takeSeatHandler(socket as never, context as never);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 6 }, ack);

    expect(ack.mock.calls[0]![0].occupant).toBeNull();
    expect(fetchSocketsSafeMock).not.toHaveBeenCalled();
  });

  it("returns occupant:null when the seat is actually empty in Redis (race resolved)", async () => {
    const context = makeContext({
      takeResult: { success: false, error: Errors.SEAT_TAKEN },
      seats: [{ index: 6, userId: null, muted: false, locked: false }],
    });

    const h = takeSeatHandler(socket as never, context as never);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 6 }, ack);

    expect(ack.mock.calls[0]![0].occupant).toBeNull();
    expect(fetchSocketsSafeMock).not.toHaveBeenCalled();
  });

  it("does not enrich other rejection errors", async () => {
    const context = makeContext({
      takeResult: { success: false, error: Errors.INTERNAL_ERROR },
    });

    const h = takeSeatHandler(socket as never, context as never);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 6 }, ack);

    const response = ack.mock.calls[0]![0];
    expect(response.success).toBe(false);
    expect(response).not.toHaveProperty("occupant");
    expect(context.seatRepository.getSeats).not.toHaveBeenCalled();
  });
});
