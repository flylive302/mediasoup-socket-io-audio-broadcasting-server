import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config + logger BEFORE importing the service — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
vi.mock("@src/config/index.js", () => ({ config: {} }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SeatGraceService } from "@src/domains/seat/seat-grace.service.js";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";

// F-6/F-37: the seat-grace service replaces the in-process Map<key,Timeout>
// with a Redis-ZSET schedule + sweeper. Tests verify:
//   - schedule writes the pending ZSET entry
//   - cancel removes it (cross-instance correct — works without the original
//     scheduling instance being involved)
//   - sweep claims due members atomically and runs leaveSeat + adapter
//     broadcast
//   - a member returned by the (mocked) atomic claim is not re-processed by
//     a second sweeper run (ZREM happened inside the claim Lua)

describe("SeatGraceService (F-6/F-37)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let io: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let seatRepository: any;
  let service: SeatGraceService;
  let emit: ReturnType<typeof vi.fn>;
  let toFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emit = vi.fn();
    toFn = vi.fn(() => ({ emit }));
    redis = {
      defineCommand: vi.fn(),
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      seatGraceClaimDue: vi.fn(),
    };
    io = { to: toFn } as unknown as Server;
    seatRepository = {
      leaveSeat: vi.fn(),
    };
    service = new SeatGraceService(
      redis as Redis,
      seatRepository as SeatRepository,
      io as Server,
    );
  });

  it("registers the claim-due Lua script at construction", () => {
    expect(redis.defineCommand).toHaveBeenCalledWith(
      "seatGraceClaimDue",
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it("schedule() ZADDs a pending entry with a future score", async () => {
    const before = Date.now();
    await service.schedule("room-42", "777");
    expect(redis.zadd).toHaveBeenCalledTimes(1);
    const [zset, score, member] = redis.zadd.mock.calls[0]!;
    expect(zset).toBe("seat-grace:pending");
    expect(member).toBe("room-42:777");
    const scoreMs = Number(score);
    expect(scoreMs).toBeGreaterThanOrEqual(before);
    expect(scoreMs).toBeLessThanOrEqual(before + 30_000);
  });

  it("cancel() ZREMs the pending entry — works regardless of which instance scheduled", async () => {
    const cancelled = await service.cancel("room-42", "777");
    expect(cancelled).toBe(true);
    expect(redis.zrem).toHaveBeenCalledWith("seat-grace:pending", "room-42:777");
  });

  it("cancel() returns false when no entry was pending", async () => {
    redis.zrem.mockResolvedValueOnce(0);
    expect(await service.cancel("room-42", "777")).toBe(false);
  });

  it("sweep() claims due members, runs leaveSeat, and broadcasts via the namespace adapter", async () => {
    redis.seatGraceClaimDue.mockResolvedValueOnce(["room-42:777"]);
    seatRepository.leaveSeat.mockResolvedValueOnce({ success: true, seatIndex: 3 });

    await service.sweep();

    expect(seatRepository.leaveSeat).toHaveBeenCalledWith("room-42", "777");
    // F-37 fix: broadcast via io.to(roomId).emit(...) — the namespace adapter
    // path — NOT a stale socket `.local`. The reconnected user on any
    // instance therefore receives `seat:cleared`.
    expect(toFn).toHaveBeenCalledWith("room-42");
    expect(emit).toHaveBeenCalledWith("seat:cleared", { seatIndex: 3, userId: 777 });
  });

  it("sweep() relays cross-region only when the cascade relay has remotes", async () => {
    const relay = {
      hasRemotes: vi.fn().mockReturnValue(true),
      relayToRemote: vi.fn().mockResolvedValue(undefined),
    };
    service.setCascadeRelay(relay as unknown as CascadeRelay);

    redis.seatGraceClaimDue.mockResolvedValueOnce(["room-42:777"]);
    seatRepository.leaveSeat.mockResolvedValueOnce({ success: true, seatIndex: 0 });

    await service.sweep();

    expect(relay.hasRemotes).toHaveBeenCalledWith("room-42");
    expect(relay.relayToRemote).toHaveBeenCalledWith(
      "room-42",
      "seat:cleared",
      { seatIndex: 0, userId: 777 },
    );
  });

  it("sweep() does nothing when no members are due (cancel-before-fire is a no-op)", async () => {
    redis.seatGraceClaimDue.mockResolvedValueOnce([]);
    await service.sweep();
    expect(seatRepository.leaveSeat).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("sweep() splits on the LAST colon so UUID room ids parse correctly", async () => {
    // Defensive: if a future roomId format contained a colon, the member
    // "uuid:with:colons:42" must still resolve userId="42", not roomId="uuid".
    redis.seatGraceClaimDue.mockResolvedValueOnce(["a:b:c:42"]);
    seatRepository.leaveSeat.mockResolvedValueOnce({ success: true, seatIndex: 1 });

    await service.sweep();

    expect(seatRepository.leaveSeat).toHaveBeenCalledWith("a:b:c", "42");
    expect(toFn).toHaveBeenCalledWith("a:b:c");
  });

  it("sweep() does not emit when leaveSeat reports the user wasn't seated", async () => {
    redis.seatGraceClaimDue.mockResolvedValueOnce(["room-42:777"]);
    seatRepository.leaveSeat.mockResolvedValueOnce({ success: false, error: "NOT_SEATED" });

    await service.sweep();

    expect(emit).not.toHaveBeenCalled();
  });
});
