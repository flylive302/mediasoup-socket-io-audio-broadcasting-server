import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("mediasoup", () => ({}));

import { PipeManager } from "@src/domains/media/pipe-manager.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ─── Mock Helpers ───────────────────────────────────────────────────

function createMockPlainTransport() {
  const closeHandlers: (() => void)[] = [];
  return {
    id: `pt-${Math.random().toString(36).slice(2)}`,
    tuple: { localAddress: "10.0.1.1", localPort: 40001 },
    srtpParameters: undefined,
    consume: vi.fn().mockResolvedValue({
      id: "consumer-1",
      kind: "audio",
      rtpParameters: { codecs: [{ mimeType: "audio/opus", payloadType: 100, clockRate: 48000, channels: 2 }], encodings: [{ ssrc: 12345 }] },
    }),
    produce: vi.fn().mockResolvedValue({ id: "producer-1" }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    observer: {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "close") closeHandlers.push(handler);
      }),
    },
    _triggerClose: () => closeHandlers.forEach((h) => h()),
  };
}

function createMockRouter() {
  const mockTransport = createMockPlainTransport();
  return {
    transport: mockTransport,
    router: {
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      createPlainTransport: vi.fn().mockResolvedValue(mockTransport),
    },
  };
}

const edgeCaps = { codecs: [], headerExtensions: [] };

// ─── Tests ──────────────────────────────────────────────────────────

describe("PipeManager", () => {
  let pipeManager: PipeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    pipeManager = new PipeManager(mockLogger);
  });

  const edgeAddr = { ip: "10.0.2.5", port: 41234 };

  describe("createOriginPipe", () => {
    it("creates a plain transport, connects to edge, and consumes the producer", async () => {
      const { router, transport } = createMockRouter();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await pipeManager.createOriginPipe(router as any, "prod-1", "room-1", edgeAddr, edgeCaps as any);

      expect(router.createPlainTransport).toHaveBeenCalledWith(
        expect.objectContaining({ rtcpMux: true, comedia: false }),
      );
      // Origin must connect to edge BEFORE consume so RTP has a destination.
      expect(transport.connect).toHaveBeenCalledWith({ ip: edgeAddr.ip, port: edgeAddr.port });
      // Origin must consume with the EDGE's caps so the consumer's rtpParameters
      // reflect what the edge can decode.
      expect(transport.consume).toHaveBeenCalledWith(
        expect.objectContaining({ producerId: "prod-1", rtpCapabilities: edgeCaps }),
      );
      // Order matters: connect must precede consume.
      const connectCall = transport.connect.mock.invocationCallOrder[0]!;
      const consumeCall = transport.consume.mock.invocationCallOrder[0]!;
      expect(connectCall).toBeLessThan(consumeCall);
      expect(result).toEqual(
        expect.objectContaining({
          transportId: transport.id,
          ip: "10.0.1.1",
          port: 40001,
          consumerKind: "audio",
        }),
      );
      // Consumer's rtpParameters must be returned so edge can produce with matching SSRC/PT.
      expect(result.consumerRtpParameters.encodings![0]!.ssrc).toBe(12345);
    });

    it("tracks the transport for the room", async () => {
      const { router } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeManager.createOriginPipe(router as any, "prod-1", "room-1", edgeAddr, edgeCaps as any);
      expect(pipeManager.getPipeCount("room-1")).toBe(1);
    });
  });

  describe("createEdgeListener + createEdgePipeFromTransport", () => {
    it("creates a listener transport and returns its address", async () => {
      const { router, transport } = createMockRouter();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listener = await pipeManager.createEdgeListener(router as any, "room-1");

      expect(router.createPlainTransport).toHaveBeenCalledWith(
        expect.objectContaining({ rtcpMux: true, comedia: false }),
      );
      expect(listener.transport).toBe(transport);
      expect(listener.ip).toBe("10.0.1.1");
      expect(listener.port).toBe(40001);
      // Listener should be tracked immediately for cleanup.
      expect(pipeManager.getPipeCount("room-1")).toBe(1);
    });

    it("connects to origin and produces in phase 2", async () => {
      const { router, transport } = createMockRouter();
      const originInfo = {
        transportId: "origin-t-1",
        ip: "10.0.1.1",
        port: 40001,
      };
      const rtpParams = {
        codecs: [{ mimeType: "audio/opus", payloadType: 100, clockRate: 48000, channels: 2 }],
        encodings: [{ ssrc: 99 }],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listener = await pipeManager.createEdgeListener(router as any, "room-1");
      const result = await pipeManager.createEdgePipeFromTransport(
        listener.transport,
        originInfo,
        "audio",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rtpParams as any,
        "room-1",
      );

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ ip: "10.0.1.1", port: 40001 }),
      );
      expect(transport.produce).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "audio", rtpParameters: rtpParams }),
      );
      expect(result.transport).toBe(transport);
      expect(result.producer).toBeDefined();
    });
  });

  describe("closePipes", () => {
    it("closes all transports for a room", async () => {
      const { router, transport } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeManager.createOriginPipe(router as any, "prod-1", "room-1", edgeAddr, edgeCaps as any);

      expect(pipeManager.getPipeCount("room-1")).toBe(1);

      await pipeManager.closePipes("room-1");

      expect(transport.close).toHaveBeenCalled();
      expect(pipeManager.getPipeCount("room-1")).toBe(0);
    });

    it("is a no-op for rooms with no pipes", async () => {
      await pipeManager.closePipes("nonexistent");
      // Should not throw
    });
  });

  describe("auto-cleanup on transport close", () => {
    it("removes transport from tracking when it closes", async () => {
      const { router, transport } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeManager.createOriginPipe(router as any, "prod-1", "room-1", edgeAddr, edgeCaps as any);

      expect(pipeManager.getPipeCount("room-1")).toBe(1);

      // Simulate transport close event
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any)._triggerClose();

      expect(pipeManager.getPipeCount("room-1")).toBe(0);
    });
  });

  // ─── Reverse pipe (edge speaker → origin) ─────────────────────

  describe("createReverseOutboundTransport", () => {
    it("creates a plain transport on the local router", async () => {
      const { router, transport } = createMockRouter();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await pipeManager.createReverseOutboundTransport(router as any, "room-rev");

      expect(router.createPlainTransport).toHaveBeenCalledWith(
        expect.objectContaining({ rtcpMux: true, comedia: false }),
      );
      expect(out.transport).toBe(transport);
      expect(out.ip).toBe("10.0.1.1");
      expect(out.port).toBe(40001);
      expect(pipeManager.getPipeCount("room-rev")).toBe(1);
    });

    it("does NOT call connect or consume in phase 1", async () => {
      const { router, transport } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeManager.createReverseOutboundTransport(router as any, "room-rev");

      expect(transport.connect).not.toHaveBeenCalled();
      expect(transport.consume).not.toHaveBeenCalled();
    });
  });

  describe("connectReverseTransport", () => {
    it("connects to origin then consumes the local producer", async () => {
      const { router, transport } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await pipeManager.createReverseOutboundTransport(router as any, "room-rev");

      const originAddr = { ip: "10.5.5.5", port: 40500 };
      const originCaps = { codecs: [{ mimeType: "audio/opus" }], headerExtensions: [] };

      const result = await pipeManager.connectReverseTransport(
        out.transport,
        originAddr,
        "edge-prod-1",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        originCaps as any,
        "room-rev",
      );

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ ip: originAddr.ip, port: originAddr.port }),
      );
      expect(transport.consume).toHaveBeenCalledWith(
        expect.objectContaining({
          producerId: "edge-prod-1",
          rtpCapabilities: originCaps,
        }),
      );
      // connect MUST precede consume (so RTP has a destination).
      const connectCall = transport.connect.mock.invocationCallOrder[0]!;
      const consumeCall = transport.consume.mock.invocationCallOrder[0]!;
      expect(connectCall).toBeLessThan(consumeCall);

      // Consumer's rtpParameters become origin's produce input.
      expect(result.consumerRtpParameters.encodings![0]!.ssrc).toBe(12345);
      expect(result.consumerKind).toBe("audio");
    });
  });

  describe("createReverseInboundTransport", () => {
    it("creates a transport on origin's router and connects it to edge", async () => {
      const { router, transport } = createMockRouter();
      const edgeAddr2 = { ip: "10.7.7.7", port: 40700 };

      const result = await pipeManager.createReverseInboundTransport(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router as any,
        edgeAddr2,
        "room-rev",
      );

      expect(router.createPlainTransport).toHaveBeenCalledWith(
        expect.objectContaining({ rtcpMux: true, comedia: false }),
      );
      // Origin must connect to edge before edge sends RTP.
      expect(transport.connect).toHaveBeenCalledWith({
        ip: edgeAddr2.ip,
        port: edgeAddr2.port,
      });
      expect(result.transportId).toBe(transport.id);
      // Returns origin's router caps so edge can consume against them.
      expect(result.rtpCapabilities).toBe(router.rtpCapabilities);
      // Tracked for cleanup.
      expect(pipeManager.getPipeCount("room-rev")).toBe(1);
    });
  });

  describe("finalizeReverseInbound + closeReverseInboundByEdgeProducer", () => {
    it("produces with edge consumer rtpParameters and tracks by edgeProducerId", async () => {
      const { router, transport } = createMockRouter();
      const edgeAddr2 = { ip: "10.7.7.7", port: 40700 };

      const inbound = await pipeManager.createReverseInboundTransport(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router as any,
        edgeAddr2,
        "room-rev",
      );

      const rtpParams = {
        codecs: [{ mimeType: "audio/opus", payloadType: 100, clockRate: 48000, channels: 2 }],
        encodings: [{ ssrc: 7777 }],
      };

      const { producer } = await pipeManager.finalizeReverseInbound(
        inbound.transportId,
        "edge-prod-A",
        "audio",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rtpParams as any,
        { userId: 42 },
        "room-rev",
      );

      expect(transport.produce).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "audio", rtpParameters: rtpParams }),
      );
      expect(producer).toBeDefined();

      // closeReverseInboundByEdgeProducer closes the transport.
      const closed = await pipeManager.closeReverseInboundByEdgeProducer(
        "room-rev",
        "edge-prod-A",
      );
      expect(closed).toBe(true);
      expect(transport.close).toHaveBeenCalled();
    });

    it("returns false when no reverse pipe exists for that edge producer", async () => {
      const result = await pipeManager.closeReverseInboundByEdgeProducer(
        "room-none",
        "missing-prod",
      );
      expect(result).toBe(false);
    });

    it("throws if finalize is called for an unknown transportId", async () => {
      const rtpParams = { codecs: [], encodings: [] };
      await expect(
        pipeManager.finalizeReverseInbound(
          "unknown-transport",
          "edge-prod-A",
          "audio",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rtpParams as any,
          {},
          "room-rev",
        ),
      ).rejects.toThrow(/pending reverse inbound transport/);
    });
  });
});
