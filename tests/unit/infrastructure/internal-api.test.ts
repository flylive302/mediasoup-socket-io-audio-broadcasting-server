import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    CASCADE_ENABLED: true,
    INTERNAL_API_KEY: "test-internal-key-12345678",
    PUBLIC_IP: "10.0.1.100",
  },
}));

import { createInternalRoutes } from "@src/api/internal.js";
import Fastify from "fastify";

// ─── Mock Dependencies ──────────────────────────────────────────────

function createMockRoomManager() {
  return {
    getRoomCount: vi.fn().mockReturnValue(3),
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

// ─── Tests ──────────────────────────────────────────────────────────

describe("Internal API", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const roomManager = createMockRoomManager();
    const roomRegistry = createMockRoomRegistry();

    app = Fastify();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(createInternalRoutes(roomManager as any, roomRegistry as any));
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
    it("returns 501 (stubbed for Phase 5A)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/offer",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: { roomId: "room-1", producerId: "prod-1" },
      });
      expect(res.statusCode).toBe(501);
    });
  });

  describe("POST /internal/pipe/close", () => {
    it("returns 501 (stubbed for Phase 5A)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/pipe/close",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: { roomId: "room-1", instanceId: "i-edge-001" },
      });
      expect(res.statusCode).toBe(501);
    });
  });
});
