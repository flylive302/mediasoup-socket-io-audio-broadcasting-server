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
    consume: vi.fn().mockResolvedValue({ id: "consumer-1" }),
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

// ─── Tests ──────────────────────────────────────────────────────────

describe("PipeManager", () => {
  let pipeManager: PipeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    pipeManager = new PipeManager(mockLogger);
  });

  describe("createOriginPipe", () => {
    it("creates a plain transport and consumes the producer", async () => {
      const { router, transport } = createMockRouter();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await pipeManager.createOriginPipe(router as any, "prod-1", "room-1");

      expect(router.createPlainTransport).toHaveBeenCalledWith(
        expect.objectContaining({ rtcpMux: true, comedia: false }),
      );
      expect(transport.consume).toHaveBeenCalledWith(
        expect.objectContaining({ producerId: "prod-1" }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          transportId: transport.id,
          ip: "10.0.1.1",
          port: 40001,
        }),
      );
    });

    it("tracks the transport for the room", async () => {
      const { router } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeManager.createOriginPipe(router as any, "prod-1", "room-1");
      expect(pipeManager.getPipeCount("room-1")).toBe(1);
    });
  });

  describe("createEdgePipe", () => {
    it("creates a transport, connects to origin, and produces", async () => {
      const { router, transport } = createMockRouter();
      const originInfo = {
        transportId: "origin-t-1",
        ip: "10.0.1.1",
        port: 40001,
      };
      const rtpParams = { codecs: [] };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await pipeManager.createEdgePipe(router as any, originInfo, rtpParams as any, "room-1");

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ ip: "10.0.1.1", port: 40001 }),
      );
      expect(transport.produce).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "audio" }),
      );
      expect(result.transport).toBe(transport);
      expect(result.producer).toBeDefined();
    });
  });

  describe("closePipes", () => {
    it("closes all transports for a room", async () => {
      const { router, transport } = createMockRouter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeManager.createOriginPipe(router as any, "prod-1", "room-1");

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
      await pipeManager.createOriginPipe(router as any, "prod-1", "room-1");

      expect(pipeManager.getPipeCount("room-1")).toBe(1);

      // Simulate transport close event
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any)._triggerClose();

      expect(pipeManager.getPipeCount("room-1")).toBe(0);
    });
  });
});
