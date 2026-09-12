import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config + logger BEFORE importing modules under test — `src/config`
// validates env via Zod at module load and `process.env` is empty in CI.
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
vi.mock("@src/shared/room-emit.js", () => ({ broadcastToRoom: vi.fn() }));

import {
  readSnapshot,
  dropPick,
  cancelRound,
  startRound,
  getLiveRound,
  clearAllLiveRounds,
  recordPick,
  luckyNumberRoundKey,
  luckyNumberPicksKey,
} from "@src/domains/lucky-number/lucky-number.round.js";
import { resolveRound } from "@src/domains/lucky-number/lucky-number.resolve.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { setLuckyNumberRandom } from "@src/domains/lucky-number/lucky-number.random.js";

const ROOM = "room-1";

function makeRedis({
  hkeysFails = false,
  hkeysResult = [] as string[],
  hdelFails = false,
  delFails = false,
  getFails = false,
} = {}) {
  return {
    get: getFails ? vi.fn().mockRejectedValue(new Error("redis down")) : vi.fn(),
    set: vi.fn().mockResolvedValue("OK"),
    hkeys: hkeysFails
      ? vi.fn().mockRejectedValue(new Error("hkeys down"))
      : vi.fn().mockResolvedValue(hkeysResult),
    hdel: hdelFails ? vi.fn().mockRejectedValue(new Error("hdel down")) : vi.fn().mockResolvedValue(1),
    del: delFails ? vi.fn().mockRejectedValue(new Error("del down")) : vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    multi: vi.fn(() => ({
      hset: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  };
}

describe("lucky-number lifecycle (ticket 03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    mockConfig.LUCKY_NUMBER_ENABLED = true;
    setLuckyNumberRandom(() => 0.5); // → 5
  });

  afterEach(() => {
    clearAllLiveRounds();
    setLuckyNumberRandom(null);
    vi.useRealTimers();
  });

  describe("readSnapshot", () => {
    it("returns null when there is no mirror", async () => {
      const redis = makeRedis();
      redis.get.mockResolvedValue(null);
      const result = await readSnapshot(redis as never, ROOM);
      expect(result).toBeNull();
    });

    it("returns null when the mirror has already ended", async () => {
      const redis = makeRedis();
      const mirror = {
        roundId: "r1",
        roomId: ROOM,
        startedAt: Date.now() - 20_000,
        endsAt: Date.now() - 1,
        picks: { "7": 5 },
        drawn: 5,
      };
      redis.get.mockResolvedValue(JSON.stringify(mirror));
      const result = await readSnapshot(redis as never, ROOM);
      expect(result).toBeNull();
    });

    it("returns the snapshot from redis.hkeys during a live round", async () => {
      const redis = makeRedis({ hkeysResult: ["7", "8"] });
      const mirror = {
        roundId: "r1",
        roomId: ROOM,
        startedAt: Date.now(),
        endsAt: Date.now() + 10_000,
        picks: { "7": 5 },
        drawn: 5,
      };
      redis.get.mockResolvedValue(JSON.stringify(mirror));
      const result = await readSnapshot(redis as never, ROOM);
      expect(result).toEqual({
        roundId: "r1",
        endsAt: mirror.endsAt,
        pickedUserIds: ["7", "8"],
      });
    });

    it("falls back to Object.keys(mirror.picks) when hkeys rejects", async () => {
      const redis = makeRedis({ hkeysFails: true });
      const mirror = {
        roundId: "r1",
        roomId: ROOM,
        startedAt: Date.now(),
        endsAt: Date.now() + 10_000,
        picks: { "7": 5, "9": 3 },
        drawn: 5,
      };
      redis.get.mockResolvedValue(JSON.stringify(mirror));
      const result = await readSnapshot(redis as never, ROOM);
      expect(result).toEqual({
        roundId: "r1",
        endsAt: mirror.endsAt,
        pickedUserIds: ["7", "9"],
      });
    });

    it("returns null when redis.get rejects", async () => {
      const redis = makeRedis({ getFails: true });
      const result = await readSnapshot(redis as never, ROOM);
      expect(result).toBeNull();
    });
  });

  describe("dropPick", () => {
    it("removes the user from the in-memory live round's picks and calls hdel", async () => {
      const redis = makeRedis();
      const onEnd = vi.fn();
      const round = await startRound(redis as never, ROOM, onEnd);
      expect(round).not.toBeNull();
      await recordPick(redis as never, round!, "7", 5);
      expect(getLiveRound(ROOM)!.picks["7"]).toBe(5);

      await dropPick(redis as never, ROOM, "7");

      expect(getLiveRound(ROOM)!.picks["7"]).toBeUndefined();
      expect(redis.hdel).toHaveBeenCalledWith(luckyNumberPicksKey(ROOM), "7");
    });

    it("does not throw when hdel rejects", async () => {
      const redis = makeRedis({ hdelFails: true });
      const onEnd = vi.fn();
      const round = await startRound(redis as never, ROOM, onEnd);
      await recordPick(redis as never, round!, "7", 5);

      await expect(dropPick(redis as never, ROOM, "7")).resolves.toBeUndefined();
    });
  });

  describe("cancelRound", () => {
    it("disarms the timer, clears live state, and deletes both redis keys", async () => {
      const redis = makeRedis();
      const onEnd = vi.fn();
      await startRound(redis as never, ROOM, onEnd);
      expect(getLiveRound(ROOM)).not.toBeNull();

      await cancelRound(redis as never, ROOM);

      expect(getLiveRound(ROOM)).toBeNull();
      expect(redis.del).toHaveBeenCalledWith(
        luckyNumberRoundKey(ROOM),
        luckyNumberPicksKey(ROOM),
      );

      await vi.advanceTimersByTimeAsync(mockConfig.LUCKY_NUMBER_ROUND_MS);
      expect(onEnd).not.toHaveBeenCalled();
    });

    it("does not throw when redis.del rejects", async () => {
      const redis = makeRedis({ delFails: true });
      const onEnd = vi.fn();
      await startRound(redis as never, ROOM, onEnd);

      await expect(cancelRound(redis as never, ROOM)).resolves.toBeUndefined();
    });
  });

  describe("resolveRound (seat filter, lucky-number/03)", () => {
    function makeContext(getUserSeat: (userId: string) => Promise<number | null>) {
      return {
        io: { tag: "io" },
        redis: makeRedis(),
        cascadeRelay: null,
        seatRepository: {
          getUserSeat: vi.fn((_roomId: string, userId: string) => getUserSeat(userId)),
        },
      };
    }

    function makeRound(picks: Record<string, number>, drawn: number) {
      return {
        roundId: "r1",
        roomId: ROOM,
        startedAt: Date.now(),
        endsAt: Date.now() + 10_000,
        picks,
        drawn,
      };
    }

    it("drops a pick whose user has no seat (getUserSeat → null) and keeps a seated one", async () => {
      const context = makeContext(async (userId) => (userId === "8" ? null : 0));
      const round = makeRound({ "7": 4, "8": 4 }, 4);

      await resolveRound(round as never, context as never);

      expect(broadcastToRoom).toHaveBeenCalledWith(
        context.io,
        ROOM,
        "luckyNumber:result",
        expect.objectContaining({
          picks: { "7": 4 },
          winners: ["7"],
        }),
        null,
      );
    });

    it("keeps a pick when getUserSeat rejects for that user", async () => {
      const context = makeContext(async (userId) => {
        if (userId === "8") throw new Error("seat lookup down");
        return 0;
      });
      const round = makeRound({ "7": 4, "8": 4 }, 4);

      await resolveRound(round as never, context as never);

      expect(broadcastToRoom).toHaveBeenCalledWith(
        context.io,
        ROOM,
        "luckyNumber:result",
        expect.objectContaining({
          picks: { "7": 4, "8": 4 },
          winners: expect.arrayContaining(["7", "8"]),
        }),
        null,
      );
    });
  });
});
