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
