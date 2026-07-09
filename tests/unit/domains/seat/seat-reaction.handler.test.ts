import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config + logger BEFORE importing the handler — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
vi.mock("@src/config/index.js", () => ({
  config: {
    RATE_LIMIT_SEAT_REACTIONS_PER_WINDOW: 1,
    RATE_LIMIT_SEAT_REACTIONS_WINDOW_SECONDS: 1.5,
  },
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

vi.mock("@src/shared/room-emit.js", () => ({ broadcastToRoom: vi.fn() }));

import { seatReactionHandler } from "@src/domains/seat/handlers/seat-reaction.handler.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";

function makeContext({
  seatIndex,
  rateLimitAllowed,
}: {
  seatIndex: number | null;
  rateLimitAllowed: boolean;
}) {
  return {
    seatRepository: {
      getUserSeat: vi.fn().mockResolvedValue(seatIndex),
    },
    rateLimiter: {
      isAllowed: vi.fn().mockResolvedValue(rateLimitAllowed),
    },
    cascadeRelay: null,
  };
}

function makeSocket({ inRoom = true, userId = 7 } = {}) {
  return {
    data: { user: { id: userId } },
    rooms: new Set(inRoom ? ["room-1"] : []),
    nsp: {},
  };
}

describe("seat:reaction handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid payload without broadcasting", async () => {
    const context = makeContext({ seatIndex: 0, rateLimitAllowed: true });
    const socket = makeSocket();
    const fn = seatReactionHandler(socket as never, context as never);
    const callback = vi.fn();

    await fn({ roomId: "room-1", code: "not-a-hex-code!" }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the sender is not in the room", async () => {
    const context = makeContext({ seatIndex: 0, rateLimitAllowed: true });
    const socket = makeSocket({ inRoom: false });
    const fn = seatReactionHandler(socket as never, context as never);
    const callback = vi.fn();

    await fn({ roomId: "room-1", code: "1f602" }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when the sender does not occupy a seat", async () => {
    const context = makeContext({ seatIndex: null, rateLimitAllowed: true });
    const socket = makeSocket();
    const fn = seatReactionHandler(socket as never, context as never);
    const callback = vi.fn();

    await fn({ roomId: "room-1", code: "1f602" }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("rejects when rate-limited", async () => {
    const context = makeContext({ seatIndex: 0, rateLimitAllowed: false });
    const socket = makeSocket();
    const fn = seatReactionHandler(socket as never, context as never);
    const callback = vi.fn();

    await fn({ roomId: "room-1", code: "1f602" }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(broadcastToRoom).not.toHaveBeenCalled();
  });

  it("broadcasts to the room including the sender on the happy path", async () => {
    const context = makeContext({ seatIndex: 0, rateLimitAllowed: true });
    const socket = makeSocket({ userId: 42 });
    const fn = seatReactionHandler(socket as never, context as never);
    const callback = vi.fn();

    await fn({ roomId: "room-1", code: "1f602" }, callback);

    expect(broadcastToRoom).toHaveBeenCalledWith(
      socket.nsp,
      "room-1",
      "seat:reaction",
      { userId: 42, code: "1f602" },
      null,
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
