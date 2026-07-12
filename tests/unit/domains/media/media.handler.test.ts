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

  it("removes the source from client.producers and updates isSpeaker", () => {
    // dj-talk-over/01: registry is keyed by `source` ("mic" | "music"), not
    // mediasoup `kind` — closing the mic producer must not touch music.
    const client = {
      producers: new Map([["mic", "prod-1"], ["music", "prod-2"]]),
      isSpeaker: true,
    } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      client,
      "mic",
      false,
      createMockSocket(),
      "room-1",
      { cascadeCoordinator: null, cascadeRelay: null, broadcastController: { onSpeakerChange() {}, isBroadcasting: () => false } } as never,
    );
    producer._fire("transportclose");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).producers.has("mic")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).producers.has("music")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).isSpeaker).toBe(true); // music producer still present
  });

  it("sets isSpeaker=false when no producers remain", () => {
    const client = {
      producers: new Map([["mic", "prod-1"]]),
      isSpeaker: true,
    } as never;

    reactOnProducerClose(
      producer as unknown as import("mediasoup").types.Producer,
      client,
      "mic",
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

// ─── audioProduceHandler: source registry (dj-talk-over/01) ─────────

describe("audio:produce — source registry", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeTransport() {
    let n = 0;
    return {
      produce: vi.fn(async () => {
        n += 1;
        return createMockProducer(`prod-${n}`) as unknown as import("mediasoup").types.Producer;
      }),
    };
  }

  function makeContext(transport: ReturnType<typeof makeTransport>, client: {
    producers: Map<string, string>;
    isSpeaker: boolean;
    userId: number;
  }) {
    const cluster = {
      getTransport: vi.fn().mockReturnValue(transport),
      audioObserver: null,
      registerProducer: vi.fn().mockResolvedValue(undefined),
    };
    return {
      roomManager: { getRoom: vi.fn().mockReturnValue(cluster) },
      clientManager: { getClient: vi.fn().mockReturnValue(client) },
      broadcastController: { onSpeakerChange: vi.fn(), isBroadcasting: () => false },
      cascadeCoordinator: null,
      cascadeRelay: null,
    };
  }

  it("tracks mic then music as separate entries on the same client", async () => {
    const { mediaHandler } = await import("@src/domains/media/media.handler.js");
    const transport = makeTransport();
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 7 };
    const context = makeContext(transport, client);
    const socket = createMockSocket(7);

    let produceHandler: ((payload: unknown) => Promise<unknown>) | undefined;
    const socketWithOn = {
      ...socket,
      on: vi.fn((event: string, handler: (payload: unknown) => Promise<unknown>) => {
        if (event === "audio:produce") produceHandler = handler;
      }),
    } as unknown as import("socket.io").Socket;

    mediaHandler(socketWithOn, context as never);

    const basePayload = {
      roomId: "room-1",
      transportId: "123e4567-e89b-12d3-a456-426614174001",
      kind: "audio",
      rtpParameters: { codecs: [] },
    };

    await produceHandler!({ ...basePayload, source: "mic" });
    await produceHandler!({ ...basePayload, source: "music" });

    expect(client.producers.size).toBe(2);
    expect(client.producers.has("mic")).toBe(true);
    expect(client.producers.has("music")).toBe(true);
    expect(client.producers.get("mic")).not.toBe(client.producers.get("music"));
  });
});
