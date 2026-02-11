import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mediasoup and dependencies
vi.mock("mediasoup", () => ({}));

vi.mock("@src/config/index.js", () => ({
  config: {
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

  describe("active speaker management", () => {
    it("tracks active speaker producer IDs", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cluster = new RoomMediaCluster(workerManager as any, mockLogger);

      // With no active speakers set, all are considered active (default)
      expect(cluster.isActiveSpeaker("prod-1")).toBe(true);
    });

    it("updateActiveSpeakers pauses inactive and resumes active consumers", async () => {
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

      // Create a listener transport to trigger distribution router creation
      await cluster.createWebRtcTransport(false);

      // Set up mock consumers
      const consumer1 = {
        id: "c1",
        paused: false,
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined),
      };
      const consumer2 = {
        id: "c2",
        paused: true,
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined),
      };

      // Register consumers on the distribution router so getConsumer() finds them
      distRM.registerConsumer(consumer1);
      distRM.registerConsumer(consumer2);

      // Set up consumer→producer mappings in the cluster
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const csMap = (cluster as any).consumerSourceMap as Map<string, string>;
      csMap.set("c1", "prod-A");
      csMap.set("c2", "prod-B");

      // Set initial active speakers to prod-A and prod-B
      await cluster.updateActiveSpeakers(["prod-A", "prod-B"]);

      // Now update: only prod-B is active
      await cluster.updateActiveSpeakers(["prod-B"]);

      // consumer1 (prod-A) should be paused (was active, now inactive)
      expect(consumer1.pause).toHaveBeenCalled();
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
      expect((cluster as any).consumerSourceMap.size).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((cluster as any).transportOwnership.size).toBe(0);
    });
  });
});
