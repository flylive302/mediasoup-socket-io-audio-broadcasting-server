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
    activeSpeakerObserver: { interval: 200 },
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
    createActiveSpeakerObserver: vi.fn().mockResolvedValue({ on: vi.fn(), close: vi.fn() }),
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
});
