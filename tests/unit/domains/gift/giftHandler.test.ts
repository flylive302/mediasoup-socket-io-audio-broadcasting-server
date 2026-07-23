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
    GIFT_RATE_LIMIT: 330,
    GIFT_RATE_WINDOW: 60,
  },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftBatchSize: { observe: vi.fn() },
    giftsProcessed: { inc: vi.fn() },
    giftDeadLetterSize: { set: vi.fn() },
    // F-3: createHandler now records per-event throughput/latency.
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
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
    seatRepository: {
      getUserSeat: vi.fn().mockResolvedValue(3), // Default: recipient is seated at index 3
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

      // lucky-burst-draw 08: ack carries acceptedRecipientIds, known
      // synchronously at GATE time.
      expect(result).toEqual({ success: true, acceptedRecipientIds: [2] });
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
        batchId: "batch-abc",
        extraField: "should-not-be-emitted",
      };
      const sendGift = extractHandler(socket, "gift:send");
      await sendGift(payloadWithExtra);

      const emittedPayload = socket._emit.mock.calls[0]?.[1];
      expect(emittedPayload).not.toHaveProperty("extraField");
      expect(emittedPayload?.batchId).toBe("batch-abc");
      expect(Object.keys(emittedPayload!).sort()).toEqual([
        "batchId",
        "giftId",
        "quantity",
        "recipientId",
        "roomId",
        "senderId",
      ]);
    });

    it("rejects gift:send when sender === recipient, burst-native (GF-012)", async () => {
      // lucky-burst-draw 08: self-gift is now excluded PER LEG, silently —
      // for a single-recipient send that drains the burst to zero, so the
      // burst-native NO_RECIPIENTS_SEATED error surfaces (one shape below
      // the edge: legacy delegates into the same burst path).
      const socket = createMockSocket("room-1", 1); // userId = 1
      const context = createMockContext();
      handler.handle(socket, context);

      const selfGiftPayload = { ...payload, recipientId: 1 }; // same as sender
      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(selfGiftPayload);

      expect(result).toEqual({
        success: false,
        error: Errors.NO_RECIPIENTS_SEATED,
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

    it("rejects gift:send when recipient is not seated, burst-native (GF-017)", async () => {
      // lucky-burst-draw 08: an unseated leg is DROPPED silently; for a
      // single-recipient send that drains the burst to zero, so the
      // burst-native NO_RECIPIENTS_SEATED error surfaces.
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      vi.mocked(context.seatRepository.getUserSeat).mockResolvedValue(null);
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(payload);

      expect(result).toEqual({
        success: false,
        error: Errors.NO_RECIPIENTS_SEATED,
      });
      // Should NOT enqueue or broadcast
      expect(
        (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush,
      ).not.toHaveBeenCalled();
      expect(socket._emit).not.toHaveBeenCalled();
    });

    it("allows gift:send when recipient is seated (GF-017)", async () => {
      const socket = createMockSocket("room-1");
      const context = createMockContext();
      vi.mocked(context.seatRepository.getUserSeat).mockResolvedValue(5);
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      const result = await sendGift(payload);

      expect(result).toEqual({ success: true, acceptedRecipientIds: [2] });
      expect(
        (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush,
      ).toHaveBeenCalled();
    });
  });

  // ─── gift:send with recipientIds[] (lucky-burst-draw 08/04 burst) ──

  describe("gift:send burst (recipientIds[])", () => {
    const burstPayload = {
      roomId: "room-1",
      giftId: 100,
      recipientIds: [2, 3, 4],
      quantity: 1,
      batchId: "batch-xyz",
    };

    it("drops unseated legs, ack lists accepted recipients only (mixed seated/unseated)", async () => {
      const socket = createMockSocket("room-1", 1);
      const context = createMockContext();
      vi.mocked(context.seatRepository.getUserSeat).mockImplementation(
        async (_roomId: string, userId: string) => (userId === "3" ? null : 5),
      );
      handler.handle(socket, context);

      const sendBurst = extractHandler(socket, "gift:send");
      const result = await sendBurst(burstPayload);

      expect(result).toEqual({ success: true, acceptedRecipientIds: [2, 4] });

      const rpush = (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush;
      const enqueued = JSON.parse(rpush.mock.calls[0]?.[1] as string);
      expect(enqueued.recipient_ids).toEqual([2, 4]);
    });

    it("rejects with NO_RECIPIENTS_SEATED when zero recipients are seated, nothing enqueued", async () => {
      const socket = createMockSocket("room-1", 1);
      const context = createMockContext();
      vi.mocked(context.seatRepository.getUserSeat).mockResolvedValue(null);
      handler.handle(socket, context);

      const sendBurst = extractHandler(socket, "gift:send");
      const result = await sendBurst(burstPayload);

      expect(result).toEqual({
        success: false,
        error: Errors.NO_RECIPIENTS_SEATED,
      });
      expect(
        (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush,
      ).not.toHaveBeenCalled();
      expect(socket._emit).not.toHaveBeenCalled();
    });

    it("drops the sender's own id (self-gift leg dropped) while keeping others", async () => {
      const socket = createMockSocket("room-1", 2); // userId = 2, also a recipient
      const context = createMockContext();
      handler.handle(socket, context);

      const sendBurst = extractHandler(socket, "gift:send");
      const result = await sendBurst(burstPayload); // recipientIds: [2, 3, 4]

      expect(result).toEqual({ success: true, acceptedRecipientIds: [3, 4] });
    });

    it("enqueues exactly ONE buffer row per burst with the exact row shape", async () => {
      const socket = createMockSocket("room-1", 1);
      const context = createMockContext();
      handler.handle(socket, context);

      const sendBurst = extractHandler(socket, "gift:send");
      await sendBurst(burstPayload);

      const rpush = (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush;
      expect(rpush).toHaveBeenCalledTimes(1);

      const enqueued = JSON.parse(rpush.mock.calls[0]?.[1] as string);
      expect(Object.keys(enqueued).sort()).toEqual(
        [
          "batch_id",
          "gift_id",
          "quantity",
          "recipient_ids",
          "room_id",
          "sender_id",
          "sender_socket_id",
          "timestamp",
          "transaction_id",
        ].sort(),
      );
      expect(enqueued.recipient_ids).toEqual([2, 3, 4]);
      expect(enqueued.sender_id).toBe(1);
      expect(enqueued.gift_id).toBe(100);
    });

    it("broadcasts one burst-shaped gift:received PLUS N legacy singular events", async () => {
      const socket = createMockSocket("room-1", 1);
      const context = createMockContext();
      handler.handle(socket, context);

      const sendBurst = extractHandler(socket, "gift:send");
      await sendBurst(burstPayload);

      const calls = (socket._emit as ReturnType<typeof vi.fn>).mock.calls;
      const receivedCalls = calls.filter(([event]) => event === "gift:received");
      // 3 legacy singular events + 1 burst-shaped event
      expect(receivedCalls).toHaveLength(4);

      const legacyCalls = receivedCalls.filter(
        ([, data]) => "recipientId" in (data as object),
      );
      expect(legacyCalls).toHaveLength(3);
      expect(legacyCalls.map(([, data]) => (data as { recipientId: number }).recipientId)).toEqual([2, 3, 4]);

      const burstCalls = receivedCalls.filter(
        ([, data]) => "recipientIds" in (data as object),
      );
      expect(burstCalls).toHaveLength(1);
      expect((burstCalls[0]?.[1] as { recipientIds: number[] }).recipientIds).toEqual([2, 3, 4]);
      expect((burstCalls[0]?.[1] as { batchId: string }).batchId).toBe("batch-xyz");
    });
  });

  // ─── gift:send legacy -> burst-of-1 shim ───────────────────────────

  describe("gift:send legacy shim (lucky-burst-draw 08)", () => {
    const payload = {
      roomId: "room-1",
      giftId: 100,
      recipientId: 2,
      quantity: 1,
    };

    it("normalizes recipientId into a burst-of-1 row identical in shape to a real burst", async () => {
      const socket = createMockSocket("room-1", 1);
      const context = createMockContext();
      handler.handle(socket, context);

      const sendGift = extractHandler(socket, "gift:send");
      await sendGift(payload);

      const rpush = (mockRedis as unknown as { rpush: ReturnType<typeof vi.fn> }).rpush;
      const enqueued = JSON.parse(rpush.mock.calls[0]?.[1] as string);
      expect(Object.keys(enqueued).sort()).toEqual(
        [
          "gift_id",
          "quantity",
          "recipient_ids",
          "room_id",
          "sender_id",
          "sender_socket_id",
          "timestamp",
          "transaction_id",
        ].sort(),
      );
      expect(enqueued.recipient_ids).toEqual([2]);
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
