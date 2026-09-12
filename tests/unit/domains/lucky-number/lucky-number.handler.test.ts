import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config + logger BEFORE importing the handler — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
const mockConfig = vi.hoisted(() => ({
  LUCKY_NUMBER_ENABLED: true,
  LUCKY_NUMBER_ROUND_MS: 10_000,
  LUCKY_NUMBER_COOLDOWN_MS: 15_000,
  LUCKY_NUMBER_MIN_SEATS: 2,
}));
vi.mock("@src/config/index.js", () => ({ config: mockConfig }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
  },
}));
vi.mock("@src/shared/room-emit.js", () => ({ broadcastToRoom: vi.fn() }));
vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn(),
}));

import { luckyNumberStartHandler } from "@src/domains/lucky-number/lucky-number.handler.js";
import {
  getLiveRound,
  clearAllLiveRounds,
  luckyNumberRoundKey,
  luckyNumberCooldownKey,
} from "@src/domains/lucky-number/lucky-number.round.js";
import { setLuckyNumberRandom } from "@src/domains/lucky-number/lucky-number.random.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { Errors } from "@src/shared/errors.js";

function makeRedis({ coolingDown = false, setFails = false, claimLost = false } = {}) {
  const pipeline = {
    del: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    exists: vi.fn().mockResolvedValue(coolingDown ? 1 : 0),
    set: setFails
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue(claimLost ? null : "OK"),
    multi: vi.fn(() => pipeline),
    _pipeline: pipeline,
  };
}

function makeContext({
  occupied = 3,
  redis = makeRedis(),
}: { occupied?: number; redis?: ReturnType<typeof makeRedis> } = {}) {
  return {
    io: { tag: "io" },
    redis,
    seatRepository: {
      countOccupiedSeats: vi.fn().mockResolvedValue(occupied),
    },
    cascadeRelay: null,
  };
}

function makeSocket({ inRoom = true, userId = 7 } = {}) {
  return {
    data: { user: { id: userId } },
    rooms: new Set(inRoom ? ["room-1"] : []),
    nsp: { tag: "nsp" },
  };
}

async function start(
  context = makeContext(),
  socket = makeSocket(),
  payload: unknown = { roomId: "room-1" },
) {
  const callback = vi.fn();
  await luckyNumberStartHandler(socket as never, context as never)(payload, callback);
  return callback.mock.calls[0][0] as { success: boolean; error?: string; data?: unknown };
}

describe("luckyNumber:start handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    mockConfig.LUCKY_NUMBER_ENABLED = true;
    setLuckyNumberRandom(() => 0.5); // → 5
    vi.mocked(verifyRoomManager).mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    clearAllLiveRounds();
    setLuckyNumberRandom(null);
    vi.useRealTimers();
  });

  it("rejects an invalid payload without broadcasting", async () => {
    const result = await start(makeContext(), makeSocket(), { roomId: "" });
    expect(result.success).toBe(false);
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the feature flag is off", async () => {
    mockConfig.LUCKY_NUMBER_ENABLED = false;
    const result = await start();
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_DISABLED });
    expect(verifyRoomManager).not.toHaveBeenCalled();
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the sender is not in the room", async () => {
    const result = await start(makeContext(), makeSocket({ inRoom: false }));
    expect(result).toEqual({ success: false, error: Errors.NOT_IN_ROOM });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects a plain member (not owner/admin)", async () => {
    vi.mocked(verifyRoomManager).mockResolvedValue({
      allowed: false,
      error: Errors.NOT_AUTHORIZED,
    });
    const result = await start();
    expect(result).toEqual({ success: false, error: Errors.NOT_AUTHORIZED });
    expect(verifyRoomManager).toHaveBeenCalledWith("room-1", "7", expect.anything());
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects while a round is already live", async () => {
    const context = makeContext();
    expect((await start(context)).success).toBe(true);
    vi.mocked(broadcastToRoom).mockClear();

    const result = await start(context);
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_ROUND_LIVE });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects during the cooldown after a round", async () => {
    const context = makeContext({ redis: makeRedis({ coolingDown: true }) });
    const result = await start(context);
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_COOLDOWN });
    expect(context.redis.exists).toHaveBeenCalledWith(luckyNumberCooldownKey("room-1"));
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when fewer than MIN_SEATS are occupied", async () => {
    const result = await start(makeContext({ occupied: 1 }));
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_NOT_ENOUGH_SEATS });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("refuses to start when Redis cannot persist the round", async () => {
    const context = makeContext({ redis: makeRedis({ setFails: true }) });
    const result = await start(context);
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_STATE_UNAVAILABLE });
    expect(getLiveRound("room-1")).toBeNull();
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("refuses when another instance already claimed the round in Redis (NX lost)", async () => {
    const context = makeContext({ redis: makeRedis({ claimLost: true }) });
    const result = await start(context);
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_ROUND_LIVE });
    expect(getLiveRound("room-1")).toBeNull();
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("broadcasts `started` to the room including the sender with endsAt in the future", async () => {
    const context = makeContext();
    const socket = makeSocket({ userId: 42 });
    const now = Date.now();

    const result = await start(context, socket);

    expect(result.success).toBe(true);
    const round = getLiveRound("room-1");
    expect(round).not.toBeNull();
    expect(round!.drawn).toBe(5); // deterministic via the random seam
    expect(round!.endsAt).toBe(now + mockConfig.LUCKY_NUMBER_ROUND_MS);
    expect(round!.picks).toEqual({});

    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      socket.nsp,
      "room-1",
      "luckyNumber:started",
      { roundId: round!.roundId, endsAt: round!.endsAt },
      null,
    );
    // The drawn number never leaks in `started`
    const startedPayload = vi.mocked(broadcastToRoom).mock.calls[0][3] as Record<string, unknown>;
    expect(startedPayload).not.toHaveProperty("drawn");

    // Redis mirror written with a TTL longer than the round
    expect(context.redis.set).toHaveBeenCalledWith(
      luckyNumberRoundKey("room-1"),
      expect.any(String),
      "PX",
      expect.any(Number),
      "NX",
    );
    const ttl = context.redis.set.mock.calls[0][3] as number;
    expect(ttl).toBeGreaterThan(mockConfig.LUCKY_NUMBER_ROUND_MS);
  });

  it("fires `result` once at endsAt with the drawn number, empty picks and no winners, then clears state", async () => {
    const context = makeContext();
    await start(context);
    const round = getLiveRound("room-1")!;
    vi.mocked(broadcastToRoom).mockClear();

    vi.advanceTimersByTime(mockConfig.LUCKY_NUMBER_ROUND_MS - 1);
    expect(broadcastToRoom).not.toHaveBeenCalled();
    expect(getLiveRound("room-1")).not.toBeNull();

    vi.advanceTimersByTime(1);
    await vi.runAllTicks();

    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "luckyNumber:result",
      {
        roundId: round.roundId,
        drawn: 5,
        picks: {},
        winners: [],
        cooldownMs: mockConfig.LUCKY_NUMBER_COOLDOWN_MS,
      },
      null,
    );
    expect(getLiveRound("room-1")).toBeNull();

    // Redis mirror removed + cooldown armed
    expect(context.redis._pipeline.del).toHaveBeenCalledWith(luckyNumberRoundKey("room-1"));
    expect(context.redis._pipeline.set).toHaveBeenCalledWith(
      luckyNumberCooldownKey("room-1"),
      "1",
      "PX",
      mockConfig.LUCKY_NUMBER_COOLDOWN_MS,
    );

    // A new round can start once state is cleared (cooldown mocked as elapsed)
    expect((await start(context)).success).toBe(true);
  });
});
