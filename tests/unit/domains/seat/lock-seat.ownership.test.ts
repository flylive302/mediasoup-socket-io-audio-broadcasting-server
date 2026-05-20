import { describe, it, expect, vi, beforeEach } from "vitest";
import { lockSeatHandler } from "@src/domains/seat/handlers/lock-seat.handler.js";

// F-45: seat:lock must not close a producer that no longer belongs to the
// kicked user. A rapid disconnect→reconnect→produce (or mute/unmute) can
// replace `client.producers.get("audio")` with a brand-new producer; without
// the ownership guard the lock handler would close that new producer.

vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@src/shared/room-emit.js", () => ({
  broadcastToRoom: vi.fn(),
}));

function makeProducer(userId: number) {
  return {
    id: `prod-${userId}`,
    closed: false,
    close: vi.fn(),
    appData: { userId },
  };
}

function makeContext(kickedUserId: number, producerUserId: number) {
  const producer = makeProducer(producerUserId);
  const room = { getProducer: vi.fn().mockReturnValue(producer) };
  const kickedClient = {
    userId: kickedUserId,
    producers: new Map<string, string>([["audio", producer.id]]),
    isSpeaker: true,
  };
  const context = {
    seatRepository: {
      lockSeat: vi.fn().mockResolvedValue({
        success: true,
        kicked: String(kickedUserId),
      }),
    },
    clientManager: {
      getClientsInRoom: vi.fn().mockReturnValue([kickedClient]),
    },
    roomManager: { getRoom: vi.fn().mockReturnValue(room) },
    cascadeRelay: null,
  };
  const socket = {
    data: { user: { id: 99 } },
    nsp: {},
  };
  return { producer, kickedClient, context, socket };
}

describe("seat:lock — producer ownership (F-45)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes the audio producer when it still belongs to the kicked user", async () => {
    const { producer, context, socket } = makeContext(7, 7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });
    expect(producer.close).toHaveBeenCalledTimes(1);
  });

  it("SKIPS the close when the producer's appData.userId no longer matches", async () => {
    const { producer, context, socket } = makeContext(7, 42); // mismatch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = lockSeatHandler(socket as any, context as any);
    await fn({ roomId: "room-1", seatIndex: 0 });
    expect(producer.close).not.toHaveBeenCalled();
  });
});
