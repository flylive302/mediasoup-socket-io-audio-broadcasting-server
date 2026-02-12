import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import type { Socket, Server } from "socket.io";
import type { AppContext } from "@src/context.js";
import { Errors } from "@src/shared/errors.js";

// ─── Mock modules ───────────────────────────────────────────────────
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    GIFT_BUFFER_FLUSH_INTERVAL_MS: 5000,
    GIFT_MAX_RETRIES: 3,
  },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftBatchSize: { observe: vi.fn() },
    giftsProcessed: { inc: vi.fn() },
    giftDeadLetterSize: { set: vi.fn() },
  },
}));

// Mock crypto for deterministic UUIDs
vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: vi.fn().mockReturnValue("test-correlation-id"),
}));

import { GiftHandler } from "@src/domains/gift/giftHandler.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRedis() {
  return {
    rpush: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(0), // Default: empty queue (no flush)
    lrange: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    llen: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn().mockReturnValue({
      rpush: vi.fn().mockReturnThis(),
      ltrim: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
  } as unknown as Redis;
}

function createMockLaravelClient() {
  return {
    processGiftBatch: vi.fn().mockResolvedValue({ failed: [] }),
  };
}

function createMockIo() {
  const emitFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    _emit: emitFn,
  } as unknown as Server & { _emit: ReturnType<typeof vi.fn> };
}

/**
 * createHandler wraps handlers: socket.on("event", (rawPayload, callback) => { ... })
 * The handler result is passed via callback, not returned.
 * This helper extracts the handler and invokes it with a callback to capture the result.
 */
function extractHandler(
  socket: Socket,
  eventName: string,
): (payload: unknown) => Promise<{ success: boolean; error?: string }> {
  const onCalls = vi.mocked(socket.on).mock.calls;
  const match = onCalls.find(([name]) => name === eventName);
  if (!match) throw new Error(`No handler registered for event "${eventName}"`);
  const handler = match[1] as (
    rawPayload: unknown,
    callback?: (result: { success: boolean; error?: string }) => void,
  ) => Promise<void>;

  return (payload: unknown) =>
    new Promise<{ success: boolean; error?: string }>((resolve) => {
      handler(payload, (result) => resolve(result));
    });
}

function createMockSocket(
  roomId: string,
  userId = 1,
  isInRoom = true,
): Socket & { _emit: ReturnType<typeof vi.fn> } {
  const rooms = new Set<string>([`socket-${userId}`]);
  if (isInRoom) rooms.add(roomId);

  const emitFn = vi.fn();
  return {
    id: `socket-${userId}`,
    data: {
      user: {
        id: userId,
        name: "TestUser",
        email: "test@test.com",
        avatar: "https://example.com/avatar.jpg",
        frame: "gold",
        gender: "male",
        signature: "1234567",
        date_of_birth: "1990-01-01",
        phone: "+1234567890",
        country: "US",
        coins: "1000",
        diamonds: "500",
        wealth_xp: "2500",
        charm_xp: "1200",
        is_blocked: false,
        isSpeaker: false,
      },
    },
    rooms,
    on: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    _emit: emitFn,
  } as unknown as Socket & { _emit: ReturnType<typeof vi.fn> };
}

function createMockContext() {
  const ioEmit = vi.fn();
  return {
    rateLimiter: {
      isAllowed: vi.fn().mockResolvedValue(true),
    },
    autoCloseService: {
      recordActivity: vi.fn().mockResolvedValue(undefined),
    },
    userSocketRepository: {
      getSocketIds: vi.fn().mockResolvedValue(["recipient-socket-1"]),
    },
    io: {
      to: vi.fn().mockReturnValue({ emit: ioEmit }),
      _emit: ioEmit,
    },
  } as unknown as AppContext & {
    io: { to: ReturnType<typeof vi.fn>; _emit: ReturnType<typeof vi.fn> };
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("GiftHandler", () => {
  let handler: GiftHandler;
  let mockRedis: Redis;
  let mockIo: Server;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRedis = createMockRedis();
    mockIo = createMockIo();
    const mockLaravel = createMockLaravelClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler = new GiftHandler(mockRedis, mockIo, mockLaravel as any);
  });

  // ─── gift:send ────────────────────────────────────────────────────

  describe("gift:send", () => {
    const payload = {
      roomId: "room-1",
      giftId: 100,
      recipientId: 2,
      quantity: 1,
    };

    it("processes gift successfully (happy path)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(payload);

      expect(result).toEqual({ success: true });
      // Verify broadcast with explicit fields (GF-008)
      expect(socket._emit).toHaveBeenCalledWith("gift:received", {
        senderId: 1,
        roomId: "room-1",
        giftId: 100,
        recipientId: 2,
        quantity: 1,
      });
      // Verify enqueue
      expect((mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush).toHaveBeenCalledWith(
        "gifts:pending",
        expect.any(String),
      );
      // Verify autoClose activity
      expect(context.autoCloseService.recordActivity).toHaveBeenCalledWith(
        "room-1",
      );
    });

    it("rejects gift when sender not in room (GF-001)", async () => {
      const socket = createMockSocket("room-1", 1, false); // NOT in room
      const context = createMockContext();
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(payload);

      expect(result).toEqual({
        success: false,
        error: Errors.NOT_IN_ROOM,
      });
      // Should NOT enqueue or broadcast
      expect((mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush).not.toHaveBeenCalled();
      expect(socket._emit).not.toHaveBeenCalled();
    });

    it("rejects gift when rate limited (GF-010 error constant)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      vi.mocked(context.rateLimiter.isAllowed).mockResolvedValue(false);
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(payload);

      expect(result).toEqual({
        success: false,
        error: Errors.RATE_LIMITED,
      });
      expect((mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush).not.toHaveBeenCalled();
    });

    it("uses context.rateLimiter (GF-009)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      await sendGift(payload);

      expect(context.rateLimiter.isAllowed).toHaveBeenCalledWith(
        "gift:1",
        330,
        60,
      );
    });

    it("emits only explicit fields in gift:received (GF-008)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      handler.handle(socket, context);

      // Payload with an extra field that should NOT be leaked
      const payloadWithExtra = {
        ...payload,
        extraField: "should-not-be-emitted",
      };
      const sendGift = extractHandler(socket, "gift:send");
      await sendGift(payloadWithExtra);

      const emittedPayload = socket._emit.mock.calls[0]?.[1];
      expect(emittedPayload).not.toHaveProperty("extraField");
      expect(Object.keys(emittedPayload!).sort()).toEqual([
        "giftId",
        "quantity",
        "recipientId",
        "roomId",
        "senderId",
      ]);
    });

    it("rejects gift:send when sender === recipient (GF-012)", async () => {
      const socket = createMockSocket("room-1", 1); // userId = 1
      const context = createMockContext();
      handler.handle(socket, context);

      const selfGiftPayload = { ...payload, recipientId: 1 }; // same as sender
      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(selfGiftPayload);

      expect(result).toEqual({
        success: false,
        error: Errors.CANNOT_GIFT_SELF,
      });
      // Should NOT enqueue or broadcast
      expect(
        (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush,
      ).not.toHaveBeenCalled();
      expect(socket._emit).not.toHaveBeenCalled();
    });

    it("rejects gift:send when quantity exceeds 9999 (GF-013)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      handler.handle(socket, context);

      const oversizedPayload = { ...payload, quantity: 10000 };
      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(oversizedPayload);

      // Schema validation fails → INVALID_PAYLOAD from createHandler
      expect(result).toEqual({
        success: false,
        error: Errors.INVALID_PAYLOAD,
      });
      expect(
        (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush,
      ).not.toHaveBeenCalled();
    });
  });

  // ─── gift:prepare ─────────────────────────────────────────────────

  describe("gift:prepare", () => {
    const payload = {
      roomId: "room-1",
      giftId: 100,
      recipientId: 2,
    };

    it("emits gift:prepare only to recipient sockets (GF-005)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      handler.handle(socket, context);

      const prepareGift = extractHandler(socket, "gift:prepare");
      const result = await prepareGift(payload);

      expect(result).toEqual({ success: true });
      // Should use userSocketRepository to find recipient sockets
      expect(context.userSocketRepository.getSocketIds).toHaveBeenCalledWith(2);
      // Should emit via io.to() (not sock.to())
      expect(context.io.to).toHaveBeenCalledWith(["recipient-socket-1"]);
      expect(context.io._emit).toHaveBeenCalledWith("gift:prepare", {
        giftId: 100,
        recipientId: 2,
      });
    });

    it("skips emit when recipient has no active sockets (GF-005)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      vi.mocked(context.userSocketRepository.getSocketIds).mockResolvedValue(
        [],
      );
      handler.handle(socket, context);

      const prepareGift = extractHandler(socket, "gift:prepare");
      const result = await prepareGift(payload);

      expect(result).toEqual({ success: true });
      expect(context.io.to).not.toHaveBeenCalled();
    });

    it("rejects gift:prepare when sender not in room (GF-001)", async () => {
      const socket = createMockSocket("room-1", 1, false);
      const context = createMockContext();
      handler.handle(socket, context);

      const prepareGift = extractHandler(socket, "gift:prepare");
      const result = await prepareGift(payload);

      expect(result).toEqual({
        success: false,
        error: Errors.NOT_IN_ROOM,
      });
    });

    it("rate-limits gift:prepare (GF-004)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      vi.mocked(context.rateLimiter.isAllowed).mockResolvedValue(false);
      handler.handle(socket, context);

      const prepareGift = extractHandler(socket, "gift:prepare");
      const result = await prepareGift(payload);

      expect(result).toEqual({
        success: false,
        error: Errors.RATE_LIMITED,
      });
    });
  });
});
