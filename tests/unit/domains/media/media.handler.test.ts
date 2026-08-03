import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({ config: {} }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
    mediaRoomGateRejections: { inc: vi.fn() },
  },
}));
vi.mock("@src/shared/room-emit.js", () => ({ emitToRoom: vi.fn() }));
vi.mock("@src/config/iceServers.js", () => ({ getIceServers: vi.fn() }));

import { reactOnProducerClose, mediaHandler } from "@src/domains/media/media.handler.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { logger } from "@src/infrastructure/logger.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { Errors } from "@src/shared/errors.js";
import { __resetDedupe } from "@src/infrastructure/sentry/dedupe.js";

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

// platform-security 01: `rooms` is the membership gate's only input — a real
// socket is always in its own id room plus every room it has joined.
function createMockSocket(userId = 42, joinedRooms: string[] = ["room-1"]) {
  const id = `socket-${userId}`;
  return {
    id,
    data: { user: { id: userId } },
    rooms: new Set([id, ...joinedRooms]),
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

// ─── audioProduceHandler: displaced producer cleanup (audio-pipe-observability/15) ─

describe("audio:produce — displaced producer cleanup", () => {
  beforeEach(() => vi.clearAllMocks());

  // Same shape as the "source registry" harness above, extended with
  // `cluster.getProducer` — closeDisplacedProducer resolves the live object
  // through the cluster, not the client map, so the stub must serve it.
  function makeTransport(producers: Map<string, ReturnType<typeof createMockProducer>>) {
    let n = 0;
    return {
      produce: vi.fn(async () => {
        n += 1;
        const producer = createMockProducer(`prod-${n}`);
        producers.set(producer.id, producer);
        return producer as unknown as import("mediasoup").types.Producer;
      }),
    };
  }

  function makeContext(
    transport: ReturnType<typeof makeTransport>,
    client: { producers: Map<string, string>; isSpeaker: boolean; userId: number },
    producers: Map<string, ReturnType<typeof createMockProducer>>,
  ) {
    const cluster = {
      getTransport: vi.fn().mockReturnValue(transport),
      audioObserver: null,
      registerProducer: vi.fn().mockResolvedValue(undefined),
      getProducer: vi.fn((id: string) => producers.get(id)),
    };
    return {
      roomManager: { getRoom: vi.fn().mockReturnValue(cluster) },
      clientManager: { getClient: vi.fn().mockReturnValue(client) },
      broadcastController: { onSpeakerChange: vi.fn(), isBroadcasting: () => false },
      cascadeCoordinator: null,
      cascadeRelay: null,
    };
  }

  function registerProduceHandler(socket: import("socket.io").Socket, context: unknown) {
    let produceHandler: ((payload: unknown) => Promise<unknown>) | undefined;
    const socketWithOn = {
      ...socket,
      on: vi.fn((event: string, handler: (payload: unknown) => Promise<unknown>) => {
        if (event === "audio:produce") produceHandler = handler;
      }),
    } as unknown as import("socket.io").Socket;

    mediaHandler(socketWithOn, context as never);
    return produceHandler!;
  }

  const basePayload = {
    roomId: "room-1",
    transportId: "123e4567-e89b-12d3-a456-426614174001",
    kind: "audio",
    rtpParameters: { codecs: [] },
  };

  it("closes the first producer when a second produce reuses the same source", async () => {
    // audio-pipe-observability/15: without this, the second produce silently
    // overwrote the tracking map and the first producer stayed live+piped —
    // one user was heard twice by the whole room.
    const producers = new Map<string, ReturnType<typeof createMockProducer>>();
    const transport = makeTransport(producers);
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 7 };
    const context = makeContext(transport, client, producers);
    const produceHandler = registerProduceHandler(createMockSocket(7), context);

    await produceHandler({ ...basePayload, source: "mic" });
    const firstProducer = producers.get(client.producers.get("mic")!)!;
    await produceHandler({ ...basePayload, source: "mic" });

    expect(firstProducer.close).toHaveBeenCalledTimes(1);
    expect(client.producers.get("mic")).toBe("prod-2");
  });

  it("emits audio:producerClosed carrying the displaced producer's id, not the new one", async () => {
    // Proves listeners are told to tear down the OLD producer's consumer —
    // emitting the new id here would leave dangling <audio> elements.
    const producers = new Map<string, ReturnType<typeof createMockProducer>>();
    const transport = makeTransport(producers);
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 7 };
    const context = makeContext(transport, client, producers);
    const produceHandler = registerProduceHandler(createMockSocket(7), context);

    await produceHandler({ ...basePayload, source: "mic" });
    await produceHandler({ ...basePayload, source: "mic" });

    // registerProduceHandler wraps the socket (adds an `on` spy) before handing
    // it to mediaHandler, so match by identity (id), not full object equality.
    expect(emitToRoom).toHaveBeenCalledWith(
      expect.objectContaining({ id: "socket-7" }),
      "room-1",
      "audio:producerClosed",
      expect.objectContaining({ producerId: "prod-1" }),
      null,
    );
  });

  it("a first produce for a source closes nothing and emits no audio:producerClosed", async () => {
    // Guards against the fix firing on the normal, non-displacing path.
    const producers = new Map<string, ReturnType<typeof createMockProducer>>();
    const transport = makeTransport(producers);
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 7 };
    const context = makeContext(transport, client, producers);
    const produceHandler = registerProduceHandler(createMockSocket(7), context);

    await produceHandler({ ...basePayload, source: "mic" });

    for (const p of producers.values()) {
      expect(p.close).not.toHaveBeenCalled();
    }
    expect(emitToRoom).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "audio:producerClosed",
      expect.anything(),
      expect.anything(),
    );
  });

  it("a produce for a different source does not close the other source's producer", async () => {
    // dj-talk-over/01: mic and music coexist deliberately — displacing one
    // must not touch the other.
    const producers = new Map<string, ReturnType<typeof createMockProducer>>();
    const transport = makeTransport(producers);
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 7 };
    const context = makeContext(transport, client, producers);
    const produceHandler = registerProduceHandler(createMockSocket(7), context);

    await produceHandler({ ...basePayload, source: "mic" });
    const micProducerId = client.producers.get("mic")!;
    const micProducer = producers.get(micProducerId)!;
    await produceHandler({ ...basePayload, source: "music" });

    expect(micProducer.close).not.toHaveBeenCalled();
    expect(client.producers.get("mic")).toBe(micProducerId);
  });

  it("does not re-close an already-closed displaced producer or emit for it", async () => {
    // Guards a stale map entry (e.g. the old producer already closed via
    // transportclose) from a redundant close/emit.
    const producers = new Map<string, ReturnType<typeof createMockProducer>>();
    const transport = makeTransport(producers);
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 7 };
    const context = makeContext(transport, client, producers);
    const produceHandler = registerProduceHandler(createMockSocket(7), context);

    await produceHandler({ ...basePayload, source: "mic" });
    const firstProducer = producers.get(client.producers.get("mic")!)!;
    firstProducer.closed = true;

    await produceHandler({ ...basePayload, source: "mic" });

    expect(firstProducer.close).not.toHaveBeenCalled();
    expect(emitToRoom).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "audio:producerClosed",
      expect.objectContaining({ producerId: firstProducer.id }),
      expect.anything(),
    );
  });
});

// ─── Room-membership gate (platform-security 01) ────────────────────
//
// Seam (decided in the ticket, do not substitute): the three media handlers
// are module-private consts, so these tests drive the EXPORTED registrar
// against a mock socket that records its registrations, then invoke the
// captured handler. Zero production exports were added to enable this.

type Ack = { success: boolean; error?: string; data?: unknown };
type CapturedHandler = (payload: unknown, cb?: (result: Ack) => void) => Promise<void>;

describe("media handlers — room membership gate", () => {
  const ROOM = "room-1";
  const TRANSPORT_ID = "123e4567-e89b-12d3-a456-426614174001";

  const payloadFor: Record<string, Record<string, unknown>> = {
    "transport:create": { type: "producer", roomId: ROOM },
    "transport:connect": {
      roomId: ROOM,
      transportId: TRANSPORT_ID,
      dtlsParameters: { fingerprints: [{ algorithm: "sha-256", value: "AA:BB:CC" }] },
    },
    "audio:produce": {
      roomId: ROOM,
      transportId: TRANSPORT_ID,
      kind: "audio",
      rtpParameters: { codecs: [] },
    },
    "transport:restartIce": { roomId: ROOM, transportId: TRANSPORT_ID },
  };

  /** Drive the registrar and keep every handler it registers. */
  function register(socket: import("socket.io").Socket, context: unknown) {
    const captured = new Map<string, CapturedHandler>();
    const socketWithOn = {
      ...socket,
      on: vi.fn((event: string, handler: CapturedHandler) => {
        captured.set(event, handler);
      }),
    } as unknown as import("socket.io").Socket;

    mediaHandler(socketWithOn, context as never);
    return captured;
  }

  /**
   * Every accessor throws: if the gate is not the FIRST thing the handler
   * does, the test fails loudly instead of quietly passing on a rejection
   * that happened for some other reason.
   */
  const contextThatMustNotBeTouched = {
    roomManager: {
      getRoom: () => {
        throw new Error("room lookup ran before the membership gate");
      },
    },
    clientManager: {
      getClient: () => {
        throw new Error("client lookup ran before the membership gate");
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The warn is deduped per socket per minute in a module-level map — reset
    // it so each case starts from a cold window.
    __resetDedupe();
  });

  describe.each(["transport:create", "transport:connect", "audio:produce"])(
    "%s",
    (event) => {
      it("rejects a socket that has not joined the room, with the existing NOT_IN_ROOM error", async () => {
        const socket = createMockSocket(42, []); // authenticated, never joined
        const captured = register(socket, contextThatMustNotBeTouched);

        let ack: Ack | undefined;
        await captured.get(event)!(payloadFor[event], (result) => {
          ack = result;
        });

        expect(ack).toEqual({ success: false, error: Errors.NOT_IN_ROOM });
      });

      it("makes the rejection observable to an on-call engineer", async () => {
        const socket = createMockSocket(42, []);
        const captured = register(socket, contextThatMustNotBeTouched);

        await captured.get(event)!(payloadFor[event], () => {});

        expect(metrics.mediaRoomGateRejections.inc).toHaveBeenCalledWith({ event });
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ event, roomId: ROOM, userId: 42 }),
          expect.stringContaining("has not joined this room"),
        );
      });

      it("counts every rejection but does not let one socket flood the log", async () => {
        const socket = createMockSocket(42, []);
        const captured = register(socket, contextThatMustNotBeTouched);

        for (let i = 0; i < 5; i++) {
          await captured.get(event)!(payloadFor[event], () => {});
        }

        expect(metrics.mediaRoomGateRejections.inc).toHaveBeenCalledTimes(5);
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });
    },
  );

  // Regression guard: restartIce has always been gated and must stay so. It is
  // deliberately NOT wired to the abuse counter — it races teardown by design.
  it("transport:restartIce still rejects a non-member, without feeding the abuse counter", async () => {
    const socket = createMockSocket(42, []);
    const captured = register(socket, contextThatMustNotBeTouched);

    let ack: Ack | undefined;
    await captured.get("transport:restartIce")!(
      payloadFor["transport:restartIce"],
      (r) => {
        ack = r;
      },
    );

    expect(ack).toEqual({ success: false, error: Errors.NOT_IN_ROOM });
    expect(metrics.mediaRoomGateRejections.inc).not.toHaveBeenCalled();
  });

  it("lets a joined socket create a transport exactly as before", async () => {
    const socket = createMockSocket(42, [ROOM]);
    const context = {
      clientManager: { getClient: vi.fn().mockReturnValue({ transports: new Map() }) },
      roomManager: {
        getRoom: vi.fn().mockReturnValue({
          createWebRtcTransport: vi.fn().mockResolvedValue({
            id: "transport-1",
            iceParameters: {},
            iceCandidates: [],
            dtlsParameters: {},
          }),
        }),
      },
    };
    const captured = register(socket, context);

    let ack: Ack | undefined;
    await captured.get("transport:create")!(payloadFor["transport:create"], (r) => {
      ack = r;
    });

    expect(ack?.success).toBe(true);
    expect(metrics.mediaRoomGateRejections.inc).not.toHaveBeenCalled();
  });

  it("lets a joined socket connect a transport exactly as before", async () => {
    const socket = createMockSocket(42, [ROOM]);
    const connect = vi.fn().mockResolvedValue(undefined);
    const context = {
      roomManager: {
        getRoom: vi.fn().mockReturnValue({
          getTransport: vi.fn().mockReturnValue({ closed: false, connect }),
        }),
      },
    };
    const captured = register(socket, context);

    let ack: Ack | undefined;
    await captured.get("transport:connect")!(payloadFor["transport:connect"], (r) => {
      ack = r;
    });

    expect(ack).toEqual({ success: true });
    expect(connect).toHaveBeenCalled();
  });

  it("lets a joined socket produce audio exactly as before", async () => {
    const socket = createMockSocket(42, [ROOM]);
    const client = { producers: new Map<string, string>(), isSpeaker: false, userId: 42 };
    const context = {
      roomManager: {
        getRoom: vi.fn().mockReturnValue({
          getTransport: vi.fn().mockReturnValue({
            produce: vi.fn().mockResolvedValue(createMockProducer("prod-1")),
          }),
          audioObserver: null,
          registerProducer: vi.fn().mockResolvedValue(undefined),
        }),
      },
      clientManager: { getClient: vi.fn().mockReturnValue(client) },
      broadcastController: { onSpeakerChange: vi.fn(), isBroadcasting: () => false },
      cascadeCoordinator: null,
      cascadeRelay: null,
    };
    const captured = register(socket, context);

    let ack: Ack | undefined;
    await captured.get("audio:produce")!(payloadFor["audio:produce"], (r) => {
      ack = r;
    });

    expect(ack).toEqual({ success: true, data: { id: "prod-1" } });
    expect(client.producers.get("mic")).toBe("prod-1");
  });

  it("lets a joined socket restart ICE exactly as before", async () => {
    const socket = createMockSocket(42, [ROOM]);
    const context = {
      roomManager: {
        getRoom: vi.fn().mockReturnValue({
          getTransport: vi.fn().mockReturnValue({
            closed: false,
            restartIce: vi.fn().mockResolvedValue({ usernameFragment: "u" }),
          }),
        }),
      },
    };
    const captured = register(socket, context);

    let ack: Ack | undefined;
    await captured.get("transport:restartIce")!(payloadFor["transport:restartIce"], (r) => {
      ack = r;
    });

    expect(ack?.success).toBe(true);
  });
});
