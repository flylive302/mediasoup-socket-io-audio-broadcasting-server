import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    CASCADE_ENABLED: true,
    INTERNAL_API_KEY: "test-internal-key-12345678",
    PUBLIC_IP: "10.0.1.100",
    PORT: 3030,
    LOG_LEVEL: "silent",
  },
  isDev: false,
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createInternalRoutes } from "@src/api/internal.js";
import Fastify from "fastify";

// ─── Mock Dependencies ──────────────────────────────────────────────

function createMockRoomManager() {
  return {
    getRoomCount: vi.fn().mockReturnValue(3),
    getRoom: vi.fn().mockReturnValue(null), // No rooms exist by default
  };
}

function createMockRoomRegistry() {
  return {
    registerOrigin: vi.fn(),
    getOrigin: vi.fn(),
    registerEdge: vi.fn(),
    removeEdge: vi.fn(),
    getEdges: vi.fn(),
    updateListenerCount: vi.fn(),
    getTotalListeners: vi.fn(),
    findBestInstance: vi.fn(),
    cleanup: vi.fn(),
  };
}

function createMockPipeManager() {
  return {
    createOriginPipe: vi.fn(),
    createEdgePipe: vi.fn(),
    closePipes: vi.fn(),
    getPipeCount: vi.fn().mockReturnValue(0),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Internal API", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const roomManager = createMockRoomManager();
    const roomRegistry = createMockRoomRegistry();
    const pipeManager = createMockPipeManager();

    app = Fastify();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(
      createInternalRoutes({
        roomManager: roomManager as any,
        roomRegistry: roomRegistry as any,
        pipeManager: pipeManager as any,
        cascadeRelay: null,
        cascadeCoordinator: null,
        io: null,
      }),
    );
    await app.ready();
  });

  describe("authentication", () => {
    it("returns 401 when X-Internal-Key header is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/health",
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload).message).toBe("Unauthorized");
    });

    it("returns 401 when X-Internal-Key header is wrong", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/health",
        headers: { "x-internal-key": "wrong-key" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("allows access with correct X-Internal-Key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/health",
        headers: { "x-internal-key": "test-internal-key-12345678" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /internal/health", () => {
    it("returns instance info, room count, and cascade status", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/health",
        headers: { "x-internal-key": "test-internal-key-12345678" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe("ok");
      expect(body.cascadeEnabled).toBe(true);
      expect(body.roomCount).toBe(3);
      expect(body.instanceId).toBe("10.0.1.100");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("POST /internal/pipe/offer", () => {
    it("returns 400 when missing roomId, producerId, edgeIp, or edgePort", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/offer",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when edge address or rtpCapabilities are missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/offer",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: { roomId: "room-1", producerId: "prod-1", edgeIp: "10.0.2.5", edgePort: 41234 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when room does not exist on this instance", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/offer",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {
          roomId: "room-1",
          producerId: "prod-1",
          edgeIp: "10.0.2.5",
          edgePort: 41234,
          edgeRtpCapabilities: { codecs: [], headerExtensions: [] },
        },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.message).toBe("Room not found on this instance");
    });
  });

  describe("POST /internal/pipe/close", () => {
    it("returns 400 when missing roomId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/close",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("succeeds when roomId is provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/close",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: { roomId: "room-1", edgeInstanceId: "i-edge-001" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe("ok");
    });
  });

  describe("POST /internal/cascade/relay", () => {
    it("returns 400 when missing roomId or event", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/cascade/relay",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns ok with relayed=false when sourceInstanceId matches self", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/cascade/relay",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {
          roomId: "room-1",
          event: "room:userJoined",
          data: { userId: 1 },
          sourceInstanceId: "10.0.1.100", // matches PUBLIC_IP
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.relayed).toBe(false);
      expect(body.reason).toBe("self");
    });

    it("returns ok with relayed=true for valid relay payload", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/cascade/relay",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {
          roomId: "room-1",
          event: "room:userJoined",
          data: { userId: 1 },
          sourceInstanceId: "10.0.2.200", // different instance
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.relayed).toBe(true);
    });
  });
});
