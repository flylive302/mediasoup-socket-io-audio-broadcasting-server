import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// Mock config + logger BEFORE importing the handler — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
const mockConfig = vi.hoisted(() => ({
  LUCKY_NUMBER_ENABLED: true,
  LUCKY_NUMBER_ROUND_MS: 10_000,
  LUCKY_NUMBER_COOLDOWN_MS: 15_000,
  LUCKY_NUMBER_MIN_SEATS: 2,
  RATE_LIMIT_LUCKY_NUMBER_PICKS_PER_WINDOW: 1,
  RATE_LIMIT_LUCKY_NUMBER_PICKS_WINDOW_SECONDS: 0.3,
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
import { luckyNumberPickHandler } from "@src/domains/lucky-number/lucky-number-pick.handler.js";
import {
  getLiveRound,
  clearAllLiveRounds,
  luckyNumberPicksKey,
} from "@src/domains/lucky-number/lucky-number.round.js";
import { setLuckyNumberRandom } from "@src/domains/lucky-number/lucky-number.random.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { Errors } from "@src/shared/errors.js";

function makePipeline({ execFails = false } = {}) {
  return {
    del: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: execFails
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue([]),
  };
}

function makeRedis({
  mirror = null as unknown,
  hgetallResult = {} as Record<string, string>,
  execFails = false,
} = {}) {
  const pipeline = makePipeline({ execFails });
  return {
    exists: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(mirror ? JSON.stringify(mirror) : null),
    hgetall: vi.fn().mockResolvedValue(hgetallResult),
    set: vi.fn().mockResolvedValue("OK"),
    multi: vi.fn(() => pipeline),
    _pipeline: pipeline,
  };
}

function makeContext({
  occupied = 3,
  redis = makeRedis(),
  isAllowed = true,
  userSeat = 0 as number | null,
} = {}) {
  return {
    io: { tag: "io" },
    redis,
    seatRepository: {
      countOccupiedSeats: vi.fn().mockResolvedValue(occupied),
      getUserSeat: vi.fn().mockResolvedValue(userSeat),
    },
    rateLimiter: {
      isAllowed: vi.fn().mockResolvedValue(isAllowed),
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

async function start(context: ReturnType<typeof makeContext>, socket = makeSocket()) {
  const callback = vi.fn();
  await luckyNumberStartHandler(socket as never, context as never)(
    { roomId: "room-1" },
    callback,
  );
  return callback.mock.calls[0][0] as { success: boolean; data?: { roundId: string } };
}

async function pick(
  context: ReturnType<typeof makeContext>,
  socket = makeSocket(),
  payload: unknown,
) {
  const callback = vi.fn();
  await luckyNumberPickHandler(socket as never, context as never)(payload, callback);
  return callback.mock.calls[0][0] as { success: boolean; error?: string };
}

describe("luckyNumber:pick handler", () => {
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

  it.each([
    ["number 0", { roomId: "room-1", roundId: randomUUID(), number: 0 }],
    ["number 10", { roomId: "room-1", roundId: randomUUID(), number: 10 }],
    ["number 2.5", { roomId: "room-1", roundId: randomUUID(), number: 2.5 }],
    ["missing roundId", { roomId: "room-1", number: 5 }],
    ["non-uuid roundId", { roomId: "room-1", roundId: "not-a-uuid", number: 5 }],
  ])("rejects invalid payload: %s", async (_label, payload) => {
    const context = makeContext();
    const result = await pick(context, makeSocket(), payload);
    expect(result.success).toBe(false);
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the feature flag is off", async () => {
    mockConfig.LUCKY_NUMBER_ENABLED = false;
    const context = makeContext();
    const result = await pick(context, makeSocket(), {
      roomId: "room-1",
      roundId: randomUUID(),
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_DISABLED });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the sender is not in the room", async () => {
    const context = makeContext();
    const result = await pick(context, makeSocket({ inRoom: false }), {
      roomId: "room-1",
      roundId: randomUUID(),
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.NOT_IN_ROOM });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the sender is not seated", async () => {
    const context = makeContext({ userSeat: null });
    const result = await pick(context, makeSocket(), {
      roomId: "room-1",
      roundId: randomUUID(),
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.NOT_SEATED });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when there is no live round", async () => {
    const context = makeContext();
    const result = await pick(context, makeSocket(), {
      roomId: "room-1",
      roundId: randomUUID(),
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_NO_ROUND });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when roundId does not match the live round", async () => {
    const context = makeContext();
    await start(context);
    vi.mocked(broadcastToRoom).mockClear();
    const result = await pick(context, makeSocket(), {
      roomId: "room-1",
      roundId: randomUUID(),
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_NO_ROUND });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects via the Redis mirror when the round has ended", async () => {
    const roundId = randomUUID();
    const mirror = {
      roundId,
      roomId: "room-1",
      startedAt: Date.now() - 20_000,
      endsAt: Date.now() - 1_000,
      picks: {},
      drawn: 5,
    };
    const context = makeContext({ redis: makeRedis({ mirror }) });
    const result = await pick(context, makeSocket(), { roomId: "room-1", roundId, number: 5 });
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_ROUND_OVER });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("accepts a pick via the Redis mirror (cascaded room, no local round)", async () => {
    const roundId = randomUUID();
    const mirror = {
      roundId,
      roomId: "room-1",
      startedAt: Date.now(),
      endsAt: Date.now() + 10_000,
      picks: {},
      drawn: 5,
    };
    const redis = makeRedis({ mirror });
    const context = makeContext({ redis });
    const result = await pick(context, makeSocket(), { roomId: "room-1", roundId, number: 5 });

    expect(result).toEqual({ success: true });
    expect(redis._pipeline.hset).toHaveBeenCalledWith(
      luckyNumberPicksKey("room-1"),
      "7",
      "5",
    );
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      { tag: "nsp" },
      "room-1",
      "luckyNumber:picked",
      { roundId, userId: 7 },
      null,
    );
  });

  it("rejects when rate limited, without writing or broadcasting", async () => {
    const context = makeContext({ isAllowed: false });
    await start(context);
    const round = getLiveRound("room-1")!;
    vi.mocked(broadcastToRoom).mockClear();
    const result = await pick(context, makeSocket(), {
      roomId: "room-1",
      roundId: round.roundId,
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.RATE_LIMITED });
    expect(broadcastToRoom).not.toHaveBeenCalled();
    expect(context.redis._pipeline.hset).not.toHaveBeenCalled();
  });

  it("returns LUCKY_NUMBER_STATE_UNAVAILABLE when the Redis write fails", async () => {
    const redis = makeRedis({ execFails: true });
    const context = makeContext({ redis });
    await start(context);
    const round = getLiveRound("room-1")!;
    vi.mocked(broadcastToRoom).mockClear();
    const result = await pick(context, makeSocket(), {
      roomId: "room-1",
      roundId: round.roundId,
      number: 5,
    });
    expect(result).toEqual({ success: false, error: Errors.LUCKY_NUMBER_STATE_UNAVAILABLE });
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("broadcasts `picked` with only roundId and userId — never the number", async () => {
    const context = makeContext();
    await start(context);
    const round = getLiveRound("room-1")!;
    vi.mocked(broadcastToRoom).mockClear();
    await pick(context, makeSocket(), { roomId: "room-1", roundId: round.roundId, number: 5 });

    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(broadcastToRoom).mock.calls[0][3] as Record<string, unknown>;
    expect(payload).toEqual({ roundId: round.roundId, userId: 7 });
    expect(JSON.stringify(payload)).not.toContain('"number"');
  });

  it("keeps the last pick when a user overwrites their guess", async () => {
    const context = makeContext();
    await start(context);
    const round = getLiveRound("room-1")!;

    await pick(context, makeSocket(), { roomId: "room-1", roundId: round.roundId, number: 3 });
    await pick(context, makeSocket(), { roomId: "room-1", roundId: round.roundId, number: 5 });

    expect(context.redis._pipeline.hset).toHaveBeenCalledTimes(2);
    expect(context.redis._pipeline.hset).toHaveBeenLastCalledWith(
      luckyNumberPicksKey("room-1"),
      "7",
      "5",
    );
    expect(getLiveRound("room-1")!.picks["7"]).toBe(5);
  });

  it("resolves the round with exact winners from the shared Redis hash", async () => {
    const redis = makeRedis({ hgetallResult: { "7": "5", "8": "3", "9": "5" } });
    const context = makeContext({ redis });
    await start(context);
    vi.mocked(broadcastToRoom).mockClear();

    await vi.advanceTimersByTimeAsync(mockConfig.LUCKY_NUMBER_ROUND_MS);

    expect(broadcastToRoom).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "luckyNumber:result",
      expect.objectContaining({
        picks: { "7": 5, "8": 3, "9": 5 },
        winners: ["7", "9"],
      }),
      null,
    );
  });

  it("resolves with empty winners when no pick matches the drawn number", async () => {
    const redis = makeRedis({ hgetallResult: { "7": "1" } });
    const context = makeContext({ redis });
    await start(context);
    vi.mocked(broadcastToRoom).mockClear();

    await vi.advanceTimersByTimeAsync(mockConfig.LUCKY_NUMBER_ROUND_MS);

    expect(broadcastToRoom).toHaveBeenCalledWith(
      context.io,
      "room-1",
      "luckyNumber:result",
      expect.objectContaining({
        picks: { "7": 1 },
        winners: [],
      }),
      null,
    );
  });

  it("finishRound also deletes the shared picks key", async () => {
    const redis = makeRedis();
    const context = makeContext({ redis });
    await start(context);

    await vi.advanceTimersByTimeAsync(mockConfig.LUCKY_NUMBER_ROUND_MS);
    await vi.waitFor(() => {
      expect(redis._pipeline.del).toHaveBeenCalledWith(luckyNumberPicksKey("room-1"));
    });
  });
});
