import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    INSTANCE_ID: "test-instance",
    AWS_REGION: "us-east-1",
    PUBLIC_IP: "10.0.0.1",
    PORT: 3030,
    INTERNAL_API_KEY: "test-key",
  },
}));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EdgePipeLifecycle } from "@src/domains/cascade/edge-pipe-lifecycle.js";

// ─── Mock Helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

function createMockProducer(id = "edge-prod-1") {
  const handlers = new Map<string, () => void>();
  return {
    id,
    closed: false,
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    _fire: (event: string) => handlers.get(event)?.(),
  };
}

function createMockTransport(id = "transport-1") {
  const closeHandlers: (() => void)[] = [];
  return {
    id,
    closed: false,
    tuple: { localAddress: "10.0.1.1", localPort: 40001 },
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    observer: {
      on: vi.fn((event: string, h: () => void) => {
        if (event === "close") closeHandlers.push(h);
      }),
    },
    _triggerClose: () => closeHandlers.forEach((h) => h()),
  };
}

function createCluster() {
  return {
    router: { rtpCapabilities: { codecs: [], headerExtensions: [] } },
    registerProducer: vi.fn().mockResolvedValue(undefined),
    getProducer: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createLifecycle(originUrls = new Map<string, string>()) {
  const pipeManager = {
    createEdgeListener: vi.fn(),
    createEdgePipeFromTransport: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roomManager = { getRoom: vi.fn() } as any;
  return {
    lifecycle: new EdgePipeLifecycle(pipeManager, roomManager, originUrls, mockLogger),
    pipeManager,
    roomManager,
    originUrls,
  };
}

function stubFetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        transportId: "t-origin-1",
        ip: "10.0.2.1",
        port: 50001,
        rtpParameters: { codecs: [], encodings: [{ ssrc: 1234 }] },
        kind: "audio",
        srtpParameters: null,
      }),
    }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("EdgePipeLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ── Cache hit ──────────────────────────────────────────────────────────

  describe("requestPipeForProducer — cache hit", () => {
    it("returns the cached edge producer id on a second call without creating a new pipe", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);

      const transport = createMockTransport();
      const producer = createMockProducer("edge-prod-1");
      const cluster = createCluster();

      pipeManager.createEdgeListener.mockResolvedValue({
        transport,
        ip: "10.0.1.1",
        port: 40001,
      });
      pipeManager.createEdgePipeFromTransport.mockResolvedValue({ producer, transport });
      stubFetchOk();

      const id1 = await lifecycle.requestPipeForProducer("room-1", "origin-prod-1", cluster);
      const id2 = await lifecycle.requestPipeForProducer("room-1", "origin-prod-1", cluster);

      expect(id1).toBe("edge-prod-1");
      expect(id2).toBe("edge-prod-1");
      // Pipe setup runs exactly once — second call is served from cache.
      expect(pipeManager.createEdgeListener).toHaveBeenCalledTimes(1);
    });
  });

  // ── Concurrent coalescing ──────────────────────────────────────────────

  describe("requestPipeForProducer — concurrent coalescing", () => {
    it("coalesces concurrent calls for the same producer into one pipe setup", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);

      const transport = createMockTransport();
      const producer = createMockProducer("edge-prod-2");
      const cluster = createCluster();

      // Delay listener creation so all three calls hit pendingPipes before it resolves.
      let resolveListener!: () => void;
      pipeManager.createEdgeListener.mockReturnValue(
        new Promise<{ transport: typeof transport; ip: string; port: number }>((res) => {
          resolveListener = () => res({ transport, ip: "10.0.1.1", port: 40001 });
        }),
      );
      pipeManager.createEdgePipeFromTransport.mockResolvedValue({ producer, transport });
      stubFetchOk();

      // Start 3 concurrent calls before any await resolves.
      const p1 = lifecycle.requestPipeForProducer("room-1", "origin-prod-2", cluster);
      const p2 = lifecycle.requestPipeForProducer("room-1", "origin-prod-2", cluster);
      const p3 = lifecycle.requestPipeForProducer("room-1", "origin-prod-2", cluster);

      // Unblock the listener so all three settle.
      resolveListener();
      const [id1, id2, id3] = await Promise.all([p1, p2, p3]);

      expect(id1).toBe("edge-prod-2");
      expect(id2).toBe("edge-prod-2");
      expect(id3).toBe("edge-prod-2");
      // Only ONE pipe setup should have happened despite three concurrent callers.
      expect(pipeManager.createEdgeListener).toHaveBeenCalledTimes(1);
    });
  });

  // ── cleanupRoom ────────────────────────────────────────────────────────

  describe("cleanupRoom", () => {
    it("removes all piped-producer entries for the room", async () => {
      // No origin URL so notifyOriginPipeClose is skipped; we're testing map removal.
      const { lifecycle } = createLifecycle();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lc = lifecycle as any;
      const roomMap = new Map([
        ["origin-prod-1", { edgeProducerId: "edge-prod-1", transport: { closed: true, close: vi.fn() } }],
      ]);
      lc.pipedProducers.set("room-1", roomMap);

      await lifecycle.cleanupRoom("room-1");

      expect(lc.pipedProducers.has("room-1")).toBe(false);
    });

    it("awaits in-flight pipes before clearing (drains pendingPipes)", async () => {
      const { lifecycle } = createLifecycle();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lc = lifecycle as any;
      let settled = false;
      const inflightPromise = new Promise<string | null>((res) =>
        setTimeout(() => {
          settled = true;
          res(null);
        }, 0),
      );
      lc.pendingPipes.set("room-1:origin-prod-X", inflightPromise);

      await lifecycle.cleanupRoom("room-1");

      expect(settled).toBe(true);
    });
  });

  // ── reactOnPipeClose (moved from cascade-coordinator.test.ts) ──────────

  describe("reactOnPipeClose", () => {
    it("evicts the pipedProducers cache entry when transportclose fires", () => {
      const { lifecycle } = createLifecycle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lc = lifecycle as any;

      const roomMap = new Map<string, unknown>();
      roomMap.set("origin-prod-1", { edgeProducerId: "edge-prod-1", transport: {} });
      lc.pipedProducers.set("room-1", roomMap);

      const producer = createMockProducer("edge-prod-1");
      lc.reactOnPipeClose(producer, "room-1", "origin-prod-1");
      producer._fire("transportclose");

      expect(roomMap.has("origin-prod-1")).toBe(false);
    });

    it("is a no-op when transportclose fires for an already-absent entry", () => {
      const { lifecycle } = createLifecycle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lc = lifecycle as any;

      const roomMap = new Map<string, unknown>();
      lc.pipedProducers.set("room-1", roomMap);

      const producer = createMockProducer("edge-prod-1");
      lc.reactOnPipeClose(producer, "room-1", "origin-prod-1");
      producer._fire("transportclose");

      expect(roomMap.size).toBe(0);
    });
  });
});
