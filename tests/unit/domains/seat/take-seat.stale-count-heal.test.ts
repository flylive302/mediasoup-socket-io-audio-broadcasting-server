import { describe, it, expect, vi, beforeEach } from "vitest";

// room-battery-perf/05: cross-region seat-count heal. When a seat-take is
// rejected as out-of-range because this region's RoomState.seatCount is stale
// (missed room.updated relay, or poisoned pre-fix), the gate refetches the
// owner-configured count from Laravel and retries once. Invariant: any seat
// within the owner-configured count is takeable on every region.

vi.mock("@src/config/index.js", () => ({
  config: { DEFAULT_SEAT_COUNT: 15, MAX_SEAT_COUNT: 30 },
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
vi.mock("@src/shared/room-emit.js", () => ({ emitToRoom: vi.fn() }));
vi.mock("@src/shared/fetch-sockets-safe.js", () => ({
  fetchSocketsSafe: vi.fn().mockResolvedValue([]),
}));

import { takeSeatHandler } from "@src/domains/seat/handlers/take-seat.handler.js";
import { Errors } from "@src/shared/errors.js";

function makeContext(opts: {
  localSeatCount: number;
  laravelMaxSeats?: number | null;
  laravelFails?: boolean;
}) {
  const state = { id: "room-1", seatCount: opts.localSeatCount };
  const takeSeat = vi
    .fn()
    .mockImplementation((_room, _user, seatIndex: number, seatCount: number) =>
      Promise.resolve(
        seatIndex >= seatCount
          ? { success: false, error: Errors.SEAT_INVALID }
          : { success: true },
      ),
    );
  return {
    context: {
      roomManager: {
        state: {
          get: vi.fn().mockResolvedValue(state),
          save: vi.fn().mockResolvedValue(undefined),
        },
      },
      seatRepository: { takeSeat, getSeats: vi.fn().mockResolvedValue([]) },
      laravelClient: {
        getRoomData: opts.laravelFails
          ? vi.fn().mockRejectedValue(new Error("laravel down"))
          : vi.fn().mockResolvedValue({
              owner_id: 1,
              max_seats: opts.laravelMaxSeats ?? null,
            }),
      },
      autoCloseService: { recordActivity: vi.fn().mockResolvedValue(undefined) },
      cascadeRelay: null,
      io: {},
    } as any,
    takeSeat,
    state,
  };
}

const socket = { data: { user: { id: 42 } }, nsp: {} } as any;

describe("takeSeat stale-count heal (room-battery-perf/05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("succeeds for a seat within the owner count after a stale local count rejected it", async () => {
    // Stale region thinks 15 seats; owner configured 25; user taps seat 20.
    const { context, takeSeat, state } = makeContext({
      localSeatCount: 15,
      laravelMaxSeats: 25,
    });

    const h = takeSeatHandler(socket, context);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 20 }, ack);

    expect(ack.mock.calls[0]![0]).toMatchObject({ success: true });
    expect(takeSeat).toHaveBeenCalledTimes(2);
    expect(takeSeat).toHaveBeenLastCalledWith("room-1", "42", 20, 25);
    // The healed count is persisted as laravel-authoritative for later actions.
    expect(context.roomManager.state.save).toHaveBeenCalledWith(
      expect.objectContaining({ seatCount: 25, seatCountSource: "laravel" }),
    );
    expect(state.seatCount).toBe(25);
  });

  it("still rejects a seat genuinely outside the owner-configured count (no retry)", async () => {
    const { context, takeSeat } = makeContext({
      localSeatCount: 15,
      laravelMaxSeats: 25,
    });

    const h = takeSeatHandler(socket, context);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 27 }, ack);

    expect(ack.mock.calls[0]![0]).toMatchObject({
      success: false,
      error: Errors.SEAT_INVALID,
    });
    expect(takeSeat).toHaveBeenCalledTimes(1);
  });

  it("does not retry or shrink when Laravel's count is not larger than local", async () => {
    const { context, takeSeat } = makeContext({
      localSeatCount: 15,
      laravelMaxSeats: 10,
    });

    const h = takeSeatHandler(socket, context);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 20 }, ack);

    expect(ack.mock.calls[0]![0]).toMatchObject({
      success: false,
      error: Errors.SEAT_INVALID,
    });
    expect(takeSeat).toHaveBeenCalledTimes(1);
    expect(context.roomManager.state.save).not.toHaveBeenCalled();
  });

  it("degrades to the plain rejection when the Laravel refetch fails", async () => {
    const { context, takeSeat } = makeContext({
      localSeatCount: 15,
      laravelFails: true,
    });

    const h = takeSeatHandler(socket, context);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 20 }, ack);

    expect(ack.mock.calls[0]![0]).toMatchObject({
      success: false,
      error: Errors.SEAT_INVALID,
    });
    expect(takeSeat).toHaveBeenCalledTimes(1);
  });

  it("ignores a null max_seats (backend without the field)", async () => {
    const { context, takeSeat } = makeContext({
      localSeatCount: 15,
      laravelMaxSeats: null,
    });

    const h = takeSeatHandler(socket, context);
    const ack = vi.fn();
    await h({ roomId: "room-1", seatIndex: 20 }, ack);

    expect(ack.mock.calls[0]![0]).toMatchObject({
      success: false,
      error: Errors.SEAT_INVALID,
    });
    expect(takeSeat).toHaveBeenCalledTimes(1);
  });
});
