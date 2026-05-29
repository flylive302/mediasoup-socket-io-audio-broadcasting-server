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
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    reversePipeSetup: { inc: vi.fn() },
  },
}));

import { ReversePipeLifecycle } from "@src/domains/cascade/reverse-pipe-lifecycle.js";
import { metrics } from "@src/infrastructure/metrics.js";

// ─── Mock Helpers ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

function createMockTransport(id = "transport-out-1") {
  const closeHandlers: (() => void)[] = [];
  return {
    id,
    closed: false,
    close: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    observer: {
      on: vi.fn((event: string, h: () => void) => {
        if (event === "close") closeHandlers.push(h);
      }),
    },
    _triggerClose: () => closeHandlers.forEach((h) => h()),
  };
}

function createMockProducer(id = "edge-prod-1") {
  return { id, closed: false };
}

function createMockCluster(transport = createMockTransport()) {
  return {
    router: { rtpCapabilities: { codecs: [], headerExtensions: [] } },
    registerProducer: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createLifecycle(originUrls = new Map<string, string>()) {
  const pipeManager = {
    createReverseOutboundTransport: vi.fn(),
    connectReverseTransport: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return {
    lifecycle: new ReversePipeLifecycle(pipeManager, originUrls, mockLogger),
    pipeManager,
    originUrls,
  };
}

function stubFetchReverseOffer(overrides: Partial<{ ok: boolean; transportId: string; ip: string; port: number }> = {}) {
  const offerPayload = {
    status: "ok",
    transportId: overrides.transportId ?? "origin-transport-1",
    ip: overrides.ip ?? "10.0.2.1",
    port: overrides.port ?? 50001,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
  };
  const finalizePayload = { status: "ok", originProducerId: "origin-prod-1" };

  let callCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const isOk = overrides.ok !== false;
      if (typeof url === "string" && url.includes("reverse-offer")) {
        callCount++;
        return { ok: isOk, json: async () => offerPayload };
      }
      if (typeof url === "string" && url.includes("reverse-finalize")) {
        return { ok: isOk, json: async () => finalizePayload };
      }
      // reverse-close: always ok
      return { ok: true, json: async () => ({}) };
    }),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ReversePipeLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ── setup: stores state + calls offer handshake ────────────────────────────

  describe("setupReversePipe — happy path", () => {
    it("stores the reverse-pipe entry and returns the origin producer id", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);
      const outboundTransport = createMockTransport("out-t-1");

      pipeManager.createReverseOutboundTransport.mockResolvedValue({
        transport: outboundTransport,
        ip: "10.0.0.1",
        port: 40100,
      });
      pipeManager.connectReverseTransport.mockResolvedValue({
        consumerKind: "audio",
        consumerRtpParameters: { codecs: [], encodings: [{ ssrc: 999 }] },
      });
      stubFetchReverseOffer();

      const edgeProducer = createMockProducer("edge-prod-1");
      const cluster = createMockCluster();

      const result = await lifecycle.setupReversePipe("room-1", edgeProducer as never, cluster, 42);

      expect(result).toEqual({ originProducerId: "origin-prod-1" });
      // Transport created once, connected once.
      expect(pipeManager.createReverseOutboundTransport).toHaveBeenCalledTimes(1);
      expect(pipeManager.connectReverseTransport).toHaveBeenCalledTimes(1);
    });

    it("records success metric on completion", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);
      const outboundTransport = createMockTransport();

      pipeManager.createReverseOutboundTransport.mockResolvedValue({
        transport: outboundTransport,
        ip: "10.0.0.1",
        port: 40100,
      });
      pipeManager.connectReverseTransport.mockResolvedValue({
        consumerKind: "audio",
        consumerRtpParameters: { codecs: [], encodings: [{ ssrc: 1 }] },
      });
      stubFetchReverseOffer();

      const edgeProducer = createMockProducer();
      await lifecycle.setupReversePipe("room-1", edgeProducer as never, createMockCluster(), 42);

      expect(metrics.reversePipeSetup.inc).toHaveBeenCalledWith({ result: "success" });
    });

    it("returns null and records failure when not an edge for the room", async () => {
      const { lifecycle } = createLifecycle(); // no origin URL

      const result = await lifecycle.setupReversePipe(
        "room-unknown",
        createMockProducer() as never,
        createMockCluster(),
        1,
      );

      expect(result).toBeNull();
      expect(metrics.reversePipeSetup.inc).not.toHaveBeenCalled();
    });

    it("returns cached originProducerId on a duplicate call", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);
      const outboundTransport = createMockTransport();

      pipeManager.createReverseOutboundTransport.mockResolvedValue({
        transport: outboundTransport,
        ip: "10.0.0.1",
        port: 40100,
      });
      pipeManager.connectReverseTransport.mockResolvedValue({
        consumerKind: "audio",
        consumerRtpParameters: { codecs: [], encodings: [{ ssrc: 1 }] },
      });
      stubFetchReverseOffer();

      const edgeProducer = createMockProducer("edge-dup");
      const result1 = await lifecycle.setupReversePipe("room-1", edgeProducer as never, createMockCluster(), 10);
      const result2 = await lifecycle.setupReversePipe("room-1", edgeProducer as never, createMockCluster(), 10);

      expect(result1).toEqual({ originProducerId: "origin-prod-1" });
      expect(result2).toEqual({ originProducerId: "origin-prod-1" });
      // Transport created only once — second call hits cache.
      expect(pipeManager.createReverseOutboundTransport).toHaveBeenCalledTimes(1);
    });
  });

  // ── close: clears state + notifies origin ─────────────────────────────────

  describe("closeReversePipe", () => {
    it("closes the outbound transport and removes the entry", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);
      const outboundTransport = createMockTransport();

      pipeManager.createReverseOutboundTransport.mockResolvedValue({
        transport: outboundTransport,
        ip: "10.0.0.1",
        port: 40100,
      });
      pipeManager.connectReverseTransport.mockResolvedValue({
        consumerKind: "audio",
        consumerRtpParameters: { codecs: [], encodings: [{ ssrc: 1 }] },
      });
      stubFetchReverseOffer();

      const edgeProducer = createMockProducer("edge-close-1");
      await lifecycle.setupReversePipe("room-1", edgeProducer as never, createMockCluster(), 5);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

      await lifecycle.closeReversePipe("room-1", "edge-close-1");

      expect(outboundTransport.close).toHaveBeenCalled();
      // Entry is gone — calling close again is a no-op.
      const fetchBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      await lifecycle.closeReversePipe("room-1", "edge-close-1");
      const fetchAfter = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(fetchAfter).toBe(fetchBefore); // no extra notify on second close
    });

    it("notifies origin with a POST to /internal/pipe/reverse-close", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);
      const outboundTransport = createMockTransport();

      pipeManager.createReverseOutboundTransport.mockResolvedValue({
        transport: outboundTransport,
        ip: "10.0.0.1",
        port: 40100,
      });
      pipeManager.connectReverseTransport.mockResolvedValue({
        consumerKind: "audio",
        consumerRtpParameters: { codecs: [], encodings: [{ ssrc: 1 }] },
      });
      stubFetchReverseOffer();

      const edgeProducer = createMockProducer("edge-notify-1");
      await lifecycle.setupReversePipe("room-1", edgeProducer as never, createMockCluster(), 7);

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal("fetch", mockFetch);

      await lifecycle.closeReversePipe("room-1", "edge-notify-1");

      const closeCall = mockFetch.mock.calls.find(([url]: [string]) =>
        url.includes("reverse-close"),
      );
      expect(closeCall).toBeDefined();
      expect(closeCall![0]).toContain("http://origin:3030");
    });

    it("is a no-op when called for an unknown producer", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle } = createLifecycle(originUrls);
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      await lifecycle.closeReversePipe("room-1", "ghost-producer");

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── pending-state guard: prevents double-close races ──────────────────────

  describe("pending-state guard (F-35)", () => {
    it("cleans up when closeReversePipe races with setupReversePipe mid-offer", async () => {
      const originUrls = new Map([["room-1", "http://origin:3030"]]);
      const { lifecycle, pipeManager } = createLifecycle(originUrls);
      const outboundTransport = createMockTransport();

      pipeManager.createReverseOutboundTransport.mockResolvedValue({
        transport: outboundTransport,
        ip: "10.0.0.1",
        port: 40100,
      });
      pipeManager.connectReverseTransport.mockResolvedValue({
        consumerKind: "audio",
        consumerRtpParameters: { codecs: [], encodings: [{ ssrc: 1 }] },
      });

      // Hold the reverse-offer fetch so we can inject closeReversePipe mid-flight.
      let resolveOffer!: () => void;
      const offerPayload = {
        status: "ok",
        transportId: "origin-transport-race",
        ip: "10.0.2.1",
        port: 50001,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          if (typeof url === "string" && url.includes("reverse-offer")) {
            await new Promise<void>((res) => { resolveOffer = res; });
            return { ok: true, json: async () => offerPayload };
          }
          return { ok: true, json: async () => ({}) };
        }),
      );

      const edgeProducer = createMockProducer("edge-race-1");
      const setupPromise = lifecycle.setupReversePipe(
        "room-1",
        edgeProducer as never,
        createMockCluster(),
        99,
      );

      // Tick: let createReverseOutboundTransport resolve and the pending entry be written.
      await Promise.resolve();
      await Promise.resolve();

      // Close while setup is awaiting the offer response.
      await lifecycle.closeReversePipe("room-1", "edge-race-1");

      // Now let the offer return.
      resolveOffer();
      const result = await setupPromise;

      // Setup must return null (detects the cleared entry) and close the transport.
      expect(result).toBeNull();
      expect(outboundTransport.close).toHaveBeenCalled();
      expect(metrics.reversePipeSetup.inc).toHaveBeenCalledWith({ result: "failure" });
    });
  });
});
