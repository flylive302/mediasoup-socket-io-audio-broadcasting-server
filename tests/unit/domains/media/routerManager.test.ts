import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mediasoup config
vi.mock("@src/config/mediasoup.js", () => ({
  mediasoupConfig: {
    router: {
      mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }],
    },
    webRtcTransport: {
      initialAvailableOutgoingBitrate: 600000,
      listenInfos: [{ protocol: "udp", ip: "0.0.0.0" }],
    },
    maxIncomingBitrate: 0,
    audioLevelObserver: { maxEntries: 16, threshold: -55, interval: 500 },
  },
}));

import { RouterManager } from "@src/domains/media/routerManager.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockWebRtcTransport(id: string) {
  const handlers = new Map<string, Function>();
  return {
    id,
    close: vi.fn(),
    closed: false,
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    _fireDtls: (state: string) => handlers.get("dtlsstatechange")?.(state),
  };
}

function createMockRouter() {
  return {
    createWebRtcTransport: vi.fn(),
    createAudioLevelObserver: vi.fn().mockResolvedValue({ on: vi.fn(), close: vi.fn() }),
    close: vi.fn(),
  };
}

function createMockWorker() {
  const mockRouter = createMockRouter();
  return {
    pid: 1234,
    createRouter: vi.fn().mockResolvedValue(mockRouter),
    _router: mockRouter,
  };
}

// observability-audio-quality 02: streams registered WITH a clientLeg go
// through observeProducerQuality / observeConsumerQuality, which attach both
// `.on(...)` and `.observer.on(...)` handlers and read `.paused` / `.score`.
function createMockProducerWithLeg(id: string) {
  return {
    id,
    on: vi.fn(),
    observer: { on: vi.fn() },
    paused: false,
    closed: false,
    score: [{ ssrc: 1, score: 10 }],
  };
}

function createMockConsumerWithLeg(id: string) {
  return {
    id,
    on: vi.fn(),
    observer: { on: vi.fn() },
    paused: false,
    producerPaused: false,
    closed: false,
    score: { score: 10 },
  };
}

// A stream registered WITHOUT a clientLeg never reaches observeXQuality, so
// it only needs what registerProducer/registerConsumer themselves touch.
function createMockStreamNoLeg(id: string) {
  return { id, on: vi.fn(), closed: false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ─── Tests ──────────────────────────────────────────────────────────

describe("RouterManager", () => {
  let worker: ReturnType<typeof createMockWorker>;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = createMockWorker();
  });

  describe("initialize()", () => {
    it("creates router and audio observer", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      await rm.initialize();

      expect(worker.createRouter).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaCodecs: expect.any(Array),
        }),
      );
      expect(rm.router).not.toBeNull();
      expect(rm.audioObserver).not.toBeNull();
    });

    it("is idempotent — second call is a no-op", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      await rm.initialize();
      await rm.initialize();

      expect(worker.createRouter).toHaveBeenCalledTimes(1);
    });
  });

  describe("createWebRtcTransport()", () => {
    it("creates transport with WebRtcServer when provided", async () => {
      const mockWebRtcServer = { id: "wrs-1" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger, mockWebRtcServer as any);
      await rm.initialize();

      const mockTransport = createMockWebRtcTransport("t-1");
      worker._router.createWebRtcTransport.mockResolvedValue(mockTransport);

      const transport = await rm.createWebRtcTransport(true);

      expect(transport.id).toBe("t-1");
      // Should use webRtcServer option
      expect(worker._router.createWebRtcTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          webRtcServer: mockWebRtcServer,
          appData: { isProducer: true },
        }),
      );
    });

    it("creates transport with fallback config when no WebRtcServer", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger, null);
      await rm.initialize();

      const mockTransport = createMockWebRtcTransport("t-2");
      worker._router.createWebRtcTransport.mockResolvedValue(mockTransport);

      const transport = await rm.createWebRtcTransport(false);

      expect(transport.id).toBe("t-2");
      expect(worker._router.createWebRtcTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          appData: { isProducer: false },
        }),
      );
    });

    it("throws if router is not initialized", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      // Don't initialize
      await expect(rm.createWebRtcTransport(true)).rejects.toThrow("Router not initialized");
    });

    it("closes transport on DTLS state 'closed'", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      await rm.initialize();

      const mockTransport = createMockWebRtcTransport("t-3");
      worker._router.createWebRtcTransport.mockResolvedValue(mockTransport);

      await rm.createWebRtcTransport(true);

      // Fire dtlsstatechange → closed
      mockTransport._fireDtls("closed");
      expect(mockTransport.close).toHaveBeenCalled();
    });

    it("stores transport for lookup via getTransport()", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      await rm.initialize();

      const mockTransport = createMockWebRtcTransport("t-4");
      worker._router.createWebRtcTransport.mockResolvedValue(mockTransport);

      await rm.createWebRtcTransport(true);

      expect(rm.getTransport("t-4")).toBe(mockTransport);
      expect(rm.getTransport("nonexistent")).toBeUndefined();
    });
  });

  describe("registerProducer()", () => {
    it("tracks producer and cleans up on transportclose", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const handlers = new Map<string, Function>();
      const producer = {
        id: "p-1",
        on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any);
      expect(rm.getProducer("p-1")).toBe(producer);

      // Trigger transportclose
      handlers.get("transportclose")?.();
      expect(rm.getProducer("p-1")).toBeUndefined();
    });
  });

  describe("registerConsumer()", () => {
    it("tracks consumer and cleans up on transportclose and producerclose", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);

      // Test transportclose cleanup
      const handlers1 = new Map<string, Function>();
      const consumer1 = {
        id: "c-1",
        on: vi.fn((event: string, handler: Function) => handlers1.set(event, handler)),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer1 as any);
      expect(rm.getConsumer("c-1")).toBe(consumer1);
      handlers1.get("transportclose")?.();
      expect(rm.getConsumer("c-1")).toBeUndefined();

      // Test producerclose cleanup
      const handlers2 = new Map<string, Function>();
      const consumer2 = {
        id: "c-2",
        on: vi.fn((event: string, handler: Function) => handlers2.set(event, handler)),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer2 as any);
      expect(rm.getConsumer("c-2")).toBe(consumer2);
      handlers2.get("producerclose")?.();
      expect(rm.getConsumer("c-2")).toBeUndefined();
    });
  });

  describe("close()", () => {
    it("closes all transports, observer, and router", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      await rm.initialize();

      const mockTransport = createMockWebRtcTransport("t-5");
      worker._router.createWebRtcTransport.mockResolvedValue(mockTransport);
      await rm.createWebRtcTransport(true);

      await rm.close();

      expect(mockTransport.close).toHaveBeenCalled();
      expect(rm.router).toBeNull();
      expect(rm.audioObserver).toBeNull();
    });

    it("clears all tracking maps", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      await rm.initialize();

      const mockTransport = createMockWebRtcTransport("t-6");
      worker._router.createWebRtcTransport.mockResolvedValue(mockTransport);
      await rm.createWebRtcTransport(true);

      // Register a producer and consumer
      const producer = { id: "p-1", on: vi.fn() };
      const consumer = { id: "c-1", on: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer as any);

      await rm.close();

      expect(rm.getTransport("t-6")).toBeUndefined();
      expect(rm.getProducer("p-1")).toBeUndefined();
      expect(rm.getConsumer("c-1")).toBeUndefined();
    });
  });

  describe("client leg enumeration", () => {
    const producerLeg = { roomId: "room-A", userId: "1" };
    const consumerLeg = { roomId: "room-B", userId: "2" };

    it("listProducers() and listConsumers() return the registered live streams", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockProducerWithLeg("p-1");
      const consumer = createMockConsumerWithLeg("c-1");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any, producerLeg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer as any, consumerLeg);

      expect(rm.listProducers()).toEqual([producer]);
      expect(rm.listConsumers()).toEqual([consumer]);
    });

    it("excludes a closed producer from listProducers() and listClientLegs()", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockProducerWithLeg("p-1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any, producerLeg);

      // Registration only wires `transportclose` — a bare `.close()` leaves
      // the handle in the private map forever unless list*() filters it.
      producer.closed = true;

      expect(rm.listProducers()).toEqual([]);
      expect(rm.listClientLegs()).toEqual([]);
    });

    it("excludes a closed consumer from listConsumers() and listClientLegs()", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const consumer = createMockConsumerWithLeg("c-1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer as any, consumerLeg);

      consumer.closed = true;

      expect(rm.listConsumers()).toEqual([]);
      expect(rm.listClientLegs()).toEqual([]);
    });

    it("default-deny: a stream registered without a clientLeg is listed but not enumerated as a client leg", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockStreamNoLeg("p-1");
      const consumer = createMockStreamNoLeg("c-1");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer as any);

      expect(rm.listProducers()).toEqual([producer]);
      expect(rm.listConsumers()).toEqual([consumer]);
      expect(rm.listClientLegs()).toEqual([]);
    });

    it("maps a producer to 'sending' and a consumer to 'receiving', carrying the exact leg and streamId", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockProducerWithLeg("p-1");
      const consumer = createMockConsumerWithLeg("c-1");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any, producerLeg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer as any, consumerLeg);

      const legs = rm.listClientLegs();
      const sendHandle = legs.find((l) => l.direction === "sending");
      const recvHandle = legs.find((l) => l.direction === "receiving");

      expect(sendHandle).toMatchObject({
        streamId: "p-1",
        direction: "sending",
        leg: producerLeg,
      });
      expect(recvHandle).toMatchObject({
        streamId: "c-1",
        direction: "receiving",
        leg: consumerLeg,
      });
    });

    it("returns handles whose stream is the exact object that was registered", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockProducerWithLeg("p-1");
      const consumer = createMockConsumerWithLeg("c-1");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any, producerLeg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerConsumer(consumer as any, consumerLeg);

      const legs = rm.listClientLegs();
      expect(legs.find((l) => l.streamId === "p-1")?.stream).toBe(producer);
      expect(legs.find((l) => l.streamId === "c-1")?.stream).toBe(consumer);
    });

    it("drops a leg from listClientLegs() when its observer fires 'close'", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockProducerWithLeg("p-1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any, producerLeg);

      expect(rm.listClientLegs()).toHaveLength(1);

      // More than one "close" handler may be registered on the same observer
      // (RouterManager's own cleanup + scoreObservers' teardown) — invoke all.
      const closeHandlers = producer.observer.on.mock.calls
        .filter(([event]) => event === "close")
        .map(([, handler]) => handler as () => void);
      expect(closeHandlers.length).toBeGreaterThan(0);
      closeHandlers.forEach((handler) => handler());

      expect(rm.listClientLegs()).toEqual([]);
    });

    it("close() clears the client-leg map", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rm = new RouterManager(worker as any, mockLogger);
      const producer = createMockProducerWithLeg("p-1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rm.registerProducer(producer as any, producerLeg);

      expect(rm.listClientLegs()).toHaveLength(1);

      await rm.close();

      expect(rm.listClientLegs()).toEqual([]);
    });
  });
});
