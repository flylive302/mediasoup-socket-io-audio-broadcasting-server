import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({ config: {} }));
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
vi.mock("@src/config/iceServers.js", () => ({ getIceServers: vi.fn() }));

import { reactOnProducerClose } from "@src/domains/media/media.handler.js";
import { emitToRoom } from "@src/shared/room-emit.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockProducer(id = "prod-1") {
  const handlers = new Map<string, () => void>();
  return {
    id,
    closed: false,
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    close: vi.fn(),
    _fire: (event: string) => handlers.get(event)?.(),
  };
}

function createMockSocket(userId = 42) {
  return {
    data: { user: { id: userId } },
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    local: { to: vi.fn().mockReturnValue({ emit: vi.fn() }) },
  } as unknown as import("socket.io").Socket;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("reactOnProducerClose", () => {
  let producer: ReturnType<typeof createMockProducer>;

  beforeEach(() => {
    vi.clearAllMocks();
    producer = createMockProducer();
  });

  it("registers a transportclose listener on the producer", () => {
    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      undefined,
      "audio",
      false,
      createMockSocket(),
      "room-1",
      {} as never,
    );

    expect(producer.on).toHaveBeenCalledWith("transportclose", expect.any(Function));
  });

  it("emits audio:producerClosed to the room when transportclose fires", () => {
    const socket = createMockSocket(99);
    const context = { cascadeCoordinator: null, cascadeRelay: null, broadcastController: { onSpeakerChange() {}, isBroadcasting: () => false } } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      undefined,
      "audio",
      false,
      socket,
      "room-1",
      context,
    );
    producer._fire("transportclose");

    expect(emitToRoom).toHaveBeenCalledWith(
      socket,
      "room-1",
      "audio:producerClosed",
      expect.objectContaining({ producerId: "prod-1", userId: 99 }),
      null,
    );
  });

  it("calls closeReversePipe when isEdgeRoom=true", () => {
    const closeReversePipe = vi.fn().mockResolvedValue(undefined);
    const context = {
      cascadeCoordinator: { closeReversePipe },
      cascadeRelay: null,
      broadcastController: { onSpeakerChange() {}, isBroadcasting: () => false },
    } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      undefined,
      "audio",
      true,
      createMockSocket(),
      "room-1",
      context,
    );
    producer._fire("transportclose");

    expect(closeReversePipe).toHaveBeenCalledWith("room-1", "prod-1");
  });

  it("does not call closeReversePipe when isEdgeRoom=false", () => {
    const closeReversePipe = vi.fn().mockResolvedValue(undefined);
    const context = {
      cascadeCoordinator: { closeReversePipe },
      cascadeRelay: null,
      broadcastController: { onSpeakerChange() {}, isBroadcasting: () => false },
    } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      undefined,
      "audio",
      false,
      createMockSocket(),
      "room-1",
      context,
    );
    producer._fire("transportclose");

    expect(closeReversePipe).not.toHaveBeenCalled();
  });

  it("removes the kind from client.producers and updates isSpeaker", () => {
    const client = {
      producers: new Map([["audio", "prod-1"], ["video", "prod-2"]]),
      isSpeaker: true,
    } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      client,
      "audio",
      false,
      createMockSocket(),
      "room-1",
      { cascadeCoordinator: null, cascadeRelay: null, broadcastController: { onSpeakerChange() {}, isBroadcasting: () => false } } as never,
    );
    producer._fire("transportclose");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).producers.has("audio")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).isSpeaker).toBe(true); // video producer still present
  });

  it("sets isSpeaker=false when no producers remain", () => {
    const client = {
      producers: new Map([["audio", "prod-1"]]),
      isSpeaker: true,
    } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      client,
      "audio",
      false,
      createMockSocket(),
      "room-1",
      { cascadeCoordinator: null, cascadeRelay: null, broadcastController: { onSpeakerChange() {}, isBroadcasting: () => false } } as never,
    );
    producer._fire("transportclose");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).isSpeaker).toBe(false);
  });
});
