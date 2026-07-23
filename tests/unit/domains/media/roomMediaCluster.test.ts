import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mediasoup and dependencies
vi.mock("mediasoup", () => ({}));

vi.mock("@src/config/index.js", () => ({
  config: {
    LOG_LEVEL: "silent",
    MAX_LISTENERS_PER_DISTRIBUTION_ROUTER: 500,
    MAX_ROOMS_PER_WORKER: 100,
  },
}));

vi.mock("@src/domains/media/routerManager.js", () => ({
  RouterManager: vi.fn(),
}));

import { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRouterManager() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transports = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const consumers = new Map<string, any>();
  return {
    router: { canConsume: vi.fn().mockReturnValue(true), pipeToRouter: vi.fn() },
    audioObserver: { on: vi.fn() },
    worker: { pid: 1000 + Math.floor(Math.random() * 1000) },
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createWebRtcTransport: vi.fn().mockImplementation(async () => {
      const id = `t-${Math.random().toString(36).slice(2)}`;
      const closeHandlers: (() => void)[] = [];
      const transport = {
        id,
        observer: {
          on: vi.fn((event: string, handler: () => void) => {
            if (event === "close") closeHandlers.push(handler);
          }),
        },
        consume: vi.fn(),
        _triggerClose: () => closeHandlers.forEach((h) => h()),
      };
      transports.set(id, transport);
      return transport;
    }),
    getTransport: vi.fn((id: string) => transports.get(id)),
    registerProducer: vi.fn(),
    getProducer: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerConsumer: vi.fn((c: any) => consumers.set(c.id, c)),
    getConsumer: vi.fn((id: string) => consumers.get(id)),
  };
}

function createMockWorkerManager() {
  return {
    getLeastLoadedWorker: vi.fn().mockReturnValue({ pid: 2000 }),
    getWebRtcServer: vi.fn().mockReturnValue(null),
    incrementRouterCount: vi.fn(),
    decrementRouterCount: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ─── Tests ──────────────────────────────────────────────────────────

describe("RoomMediaCluster", () => {
  let workerManager: ReturnType<typeof createMockWorkerManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    workerManager = createMockWorkerManager();
  });

  describe("initialization", () => {
    it("initializes source router on least-loaded worker", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const mockRM = createMockRouterManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => mockRM);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();

      expect(workerManager.getLeastLoadedWorker).toHaveBeenCalled();
      expect(mockRM.initialize).toHaveBeenCalled();
      expect(workerManager.incrementRouterCount).toHaveBeenCalled();
      expect(cluster.router).toBe(mockRM.router);
    });
  });

  describe("ARCH-001: listener count decrement on transport close", () => {
    it("decrements listener count when transport closes", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const sourceRM = createMockRouterManager();
      const distRM = createMockRouterManager();

      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => {
        return callCount++ === 0 ? sourceRM : distRM;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();

      // Create a listener transport (isProducer=false) → creates distribution router
      const transport = await cluster.createWebRtcTransport(false);

      // The transport.observer.on('close') should have been registered
      expect(transport.observer.on).toHaveBeenCalledWith(
        "close",
        expect.any(Function),
      );

      // Trigger the close handler
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any)._triggerClose();

      // Verify the logger was called with decremented count
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          transportId: transport.id,
          listenerCount: 0,
        }),
        expect.any(String),
      );
    });
  });



  describe("pipe failure handling (2026-07-10 audio review)", () => {
    function setupClusterWithDistRouter() {
      const sourceRM = createMockRouterManager();
      const distRM = createMockRouterManager();
      return { sourceRM, distRM };
    }

    it("retries a transiently failing pipe and succeeds", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const { sourceRM, distRM } = setupClusterWithDistRouter();
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => {
        return callCount++ === 0 ? sourceRM : distRM;
      });

      // First attempt fails, second succeeds
      sourceRM.router.pipeToRouter = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient worker error"))
        .mockResolvedValue({ pipeProducer: { id: "piped-1", on: vi.fn() } });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();
      await cluster.createWebRtcTransport(false); // creates distribution router

      const producer = { id: "prod-1", on: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cluster.registerProducer(producer as any);

      expect(sourceRM.router.pipeToRouter).toHaveBeenCalledTimes(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dist = (cluster as any).distributionRouters[0];
      expect(dist.pipedProducerMap.get("prod-1")).toBe("piped-1");
    });

    it("throws from registerProducer when piping fails after all retries", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const { sourceRM, distRM } = setupClusterWithDistRouter();
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => {
        return callCount++ === 0 ? sourceRM : distRM;
      });

      sourceRM.router.pipeToRouter = vi
        .fn()
        .mockRejectedValue(new Error("persistent pipe failure"));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();
      await cluster.createWebRtcTransport(false);

      const producer = { id: "prod-1", on: vi.fn() };
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cluster.registerProducer(producer as any),
      ).rejects.toThrow("persistent pipe failure");
      expect(sourceRM.router.pipeToRouter).toHaveBeenCalledTimes(3);
    });

    it("tears down a new distribution router when piping existing producers fails", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const { sourceRM, distRM } = setupClusterWithDistRouter();
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => {
        return callCount++ === 0 ? sourceRM : distRM;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();

      // Register a producer BEFORE any distribution router exists
      const producer = { id: "prod-1", on: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cluster.registerProducer(producer as any);

      // New dist-router creation must pipe prod-1 — make that fail always
      sourceRM.router.pipeToRouter = vi
        .fn()
        .mockRejectedValue(new Error("pipe failure"));

      await expect(cluster.createWebRtcTransport(false)).rejects.toThrow(
        "pipe failure",
      );
      expect(distRM.close).toHaveBeenCalled();
      expect(workerManager.decrementRouterCount).toHaveBeenCalled();
      // The broken router must NOT be visible to consumers
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((cluster as any).distributionRouters.length).toBe(0);
    });

    it("canConsume checks the router owning the given transport, not router[0]", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const sourceRM = createMockRouterManager();
      const distRM = createMockRouterManager();
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => {
        return callCount++ === 0 ? sourceRM : distRM;
      });

      sourceRM.router.pipeToRouter = vi
        .fn()
        .mockResolvedValue({ pipeProducer: { id: "piped-1", on: vi.fn() } });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();
      const transport = await cluster.createWebRtcTransport(false);

      const producer = { id: "prod-1", on: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cluster.registerProducer(producer as any);

      // Known transport on a router with the producer piped → true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(cluster.canConsume(transport.id, "prod-1", {} as any)).toBe(true);
      // Unknown transport → false (no router[0] fallback false-positive)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(cluster.canConsume("no-such-transport", "prod-1", {} as any)).toBe(
        false,
      );
      // Producer never piped → false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(cluster.canConsume(transport.id, "prod-other", {} as any)).toBe(
        false,
      );
    });
  });

  describe("cleanup", () => {
    it("stops active speaker detector on close", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const mockRM = createMockRouterManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => mockRM);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();

      const detector = { stop: vi.fn() };
      cluster.setActiveSpeakerDetector(detector);

      await cluster.close();
      expect(detector.stop).toHaveBeenCalled();
    });

    it("decrements router counts on close", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const mockRM = createMockRouterManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => mockRM);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();

      await cluster.close();
      expect(workerManager.decrementRouterCount).toHaveBeenCalled();
    });

    it("clears all internal maps on close", async () => {
      const { RouterManager } = await import("@src/domains/media/routerManager.js");
      const mockRM = createMockRouterManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (RouterManager as any).mockImplementation(() => mockRM);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);
      await cluster.initialize();

      await cluster.close();

      expect(cluster.router).toBeNull();
      // All internal sets should be cleared
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((cluster as any).sourceProducerIds.size).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((cluster as any).transportOwnership.size).toBe(0);
    });
  });
});
