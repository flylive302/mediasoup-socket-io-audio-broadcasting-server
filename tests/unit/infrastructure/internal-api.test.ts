import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    CASCADE_ENABLED: true,
    INTERNAL_API_KEY: "test-internal-key-12345678",
    PUBLIC_IP: "10.0.1.100",
    INSTANCE_ID: "10.0.1.100",
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

function createMockSeatRepository() {
  return {
    getSeats: vi.fn().mockResolvedValue([]),
  };
}

function createMockRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
    setex: vi.fn().mockResolvedValue("OK"),
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
        seatRepository: createMockSeatRepository() as any,
        redis: createMockRedis() as any,
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

    it("skips audio:newProducer when originatingEdgeId matches self (reverse-pipe bounce-back)", async () => {
      // The originating edge already produced audio:newProducer locally for its
      // edge-local producer (in audioProduceHandler). Origin's broadcast carries
      // origin's producer id + originatingEdgeId tag. Without this filter, the
      // originating edge would: (a) try to set up a forward pipe for its own
      // audio (loop), (b) duplicate the audio:newProducer broadcast.
      const handleRemoteNewProducer = vi.fn();
      const ioLocalEmit = vi.fn();
      const localApp = Fastify();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await localApp.register(
        createInternalRoutes({
          roomManager: createMockRoomManager() as any,
          roomRegistry: createMockRoomRegistry() as any,
          pipeManager: createMockPipeManager() as any,
          cascadeRelay: { relayToRemote: vi.fn(), hasRemotes: vi.fn() } as any,
          cascadeCoordinator: { handleRemoteNewProducer } as any,
          io: { local: { to: vi.fn().mockReturnValue({ emit: ioLocalEmit }) } } as any,
          seatRepository: createMockSeatRepository() as any,
          redis: createMockRedis() as any,
        }),
      );
      await localApp.ready();

      const res = await localApp.inject({
        method: "POST",
        url: "/internal/cascade/relay",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {
          roomId: "room-1",
          event: "audio:newProducer",
          data: {
            producerId: "origin-producer-7",
            userId: 42,
            originatingEdgeId: "10.0.1.100", // == mocked INSTANCE_ID
          },
          sourceInstanceId: "10.0.5.5", // some other instance
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.relayed).toBe(false);
      expect(body.reason).toBe("originating-edge");
      // Critical: must NOT attempt forward-pipe setup for our own audio.
      expect(handleRemoteNewProducer).not.toHaveBeenCalled();
      // Critical: must NOT broadcast — would be a duplicate.
      expect(ioLocalEmit).not.toHaveBeenCalled();
      await localApp.close();
    });

    it("processes audio:newProducer normally when originatingEdgeId is a different instance", async () => {
      // Foreign originatingEdgeId means this is another edge's audio coming
      // through origin → our edge needs to set up a forward pipe and broadcast.
      const handleRemoteNewProducer = vi
        .fn()
        .mockResolvedValue("our-edge-local-producer-99");
      const ioLocalEmit = vi.fn();
      const localApp = Fastify();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await localApp.register(
        createInternalRoutes({
          roomManager: createMockRoomManager() as any,
          roomRegistry: createMockRoomRegistry() as any,
          pipeManager: createMockPipeManager() as any,
          cascadeRelay: { relayToRemote: vi.fn(), hasRemotes: vi.fn() } as any,
          cascadeCoordinator: { handleRemoteNewProducer } as any,
          io: { local: { to: vi.fn().mockReturnValue({ emit: ioLocalEmit }) } } as any,
          seatRepository: createMockSeatRepository() as any,
          redis: createMockRedis() as any,
        }),
      );
      await localApp.ready();

      const res = await localApp.inject({
        method: "POST",
        url: "/internal/cascade/relay",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {
          roomId: "room-1",
          event: "audio:newProducer",
          data: {
            producerId: "origin-producer-7",
            userId: 42,
            originatingEdgeId: "10.99.99.99", // a different edge — NOT us
          },
          sourceInstanceId: "10.0.5.5",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(handleRemoteNewProducer).toHaveBeenCalledWith("room-1", "origin-producer-7");
      // Local broadcast happens after rewrite to our edge-local producer id.
      expect(ioLocalEmit).toHaveBeenCalledWith(
        "audio:newProducer",
        expect.objectContaining({ producerId: "our-edge-local-producer-99" }),
      );
      await localApp.close();
    });

    it("rewrites audio:producerClosed payload to edge-local producer id", async () => {
      // Re-mount app with a cascadeCoordinator that resolves the rewrite.
      const handleRemoteProducerClosed = vi
        .fn()
        .mockResolvedValue("edge-local-producer-99");
      const ioEmit = vi.fn();
      const localApp = Fastify();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await localApp.register(
        createInternalRoutes({
          roomManager: createMockRoomManager() as any,
          roomRegistry: createMockRoomRegistry() as any,
          pipeManager: createMockPipeManager() as any,
          cascadeRelay: { relayToRemote: vi.fn(), hasRemotes: vi.fn() } as any,
          cascadeCoordinator: { handleRemoteProducerClosed } as any,
          io: {
            local: { to: vi.fn().mockReturnValue({ emit: ioEmit }) },
          } as any,
          seatRepository: createMockSeatRepository() as any,
          redis: createMockRedis() as any,
        }),
      );
      await localApp.ready();

      const res = await localApp.inject({
        method: "POST",
        url: "/internal/cascade/relay",
        headers: { "x-internal-key": "test-internal-key-12345678" },
        payload: {
          roomId: "room-1",
          event: "audio:producerClosed",
          data: { producerId: "origin-producer-7", userId: 42 },
          sourceInstanceId: "10.0.2.200",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(handleRemoteProducerClosed).toHaveBeenCalledWith("room-1", "origin-producer-7");
      // Local broadcast carries the edge-local producer id, not origin's.
      expect(ioEmit).toHaveBeenCalledWith(
        "audio:producerClosed",
        expect.objectContaining({ producerId: "edge-local-producer-99", userId: 42 }),
      );
      await localApp.close();
    });
  });

  describe("GET /internal/room/:id/participants", () => {
    it("returns 404 when room is not on this instance", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/room/missing-room/participants",
        headers: { "x-internal-key": "test-internal-key-12345678" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns participants from origin's local sockets with isSpeaker derived from cluster", async () => {
      const cluster = {
        getSourceProducers: vi
          .fn()
          .mockReturnValue([{ producerId: "p1", userId: 100, kind: "audio" }]),
      };
      const ioMock = {
        in: vi.fn().mockReturnValue({
          fetchSockets: vi.fn().mockResolvedValue([
            {
              data: {
                user: {
                  id: 100,
                  name: "Alice",
                  signature: "sig",
                  avatar: "a.png",
                  frame: "f.png",
                  gender: 1,
                  country: "IT",
                  wealth_xp: "10",
                  charm_xp: "5",
                  vip_level: 2,
                },
              },
            },
            {
              data: {
                user: {
                  id: 101,
                  name: "Bob",
                  signature: "",
                  avatar: "",
                  frame: "",
                  gender: 0,
                  country: "ES",
                  wealth_xp: "0",
                  charm_xp: "0",
                  vip_level: 0,
                },
              },
            },
          ]),
        }),
      };

      const localApp = Fastify();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await localApp.register(
        createInternalRoutes({
          roomManager: { getRoom: vi.fn().mockReturnValue(cluster), getRoomCount: vi.fn() } as any,
          roomRegistry: createMockRoomRegistry() as any,
          pipeManager: createMockPipeManager() as any,
          cascadeRelay: null,
          cascadeCoordinator: null,
          io: ioMock as any,
          seatRepository: createMockSeatRepository() as any,
          redis: createMockRedis() as any,
        }),
      );
      await localApp.ready();

      const res = await localApp.inject({
        method: "GET",
        url: "/internal/room/room-1/participants",
        headers: { "x-internal-key": "test-internal-key-12345678" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.participants).toHaveLength(2);
      expect(body.participants[0]).toEqual(
        expect.objectContaining({ id: 100, name: "Alice", isSpeaker: true }),
      );
      expect(body.participants[1]).toEqual(
        expect.objectContaining({ id: 101, name: "Bob", isSpeaker: false }),
      );
      await localApp.close();
    });
  });

  describe("GET /internal/room/:id/snapshot", () => {
    it("returns 404 when room is not on this instance", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/room/missing-room/snapshot",
        headers: { "x-internal-key": "test-internal-key-12345678" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns seats, lockedSeats, and musicPlayer pulled from origin's redis", async () => {
      const seatRepo = {
        getSeats: vi.fn().mockResolvedValue([
          { index: 0, userId: "10", muted: false, locked: false },
          { index: 1, userId: null, muted: false, locked: true },
          { index: 2, userId: "20", muted: true, locked: false },
        ]),
      };
      const redisMock = {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            userId: 10,
            title: "Track",
            duration: 200,
            position: 50,
            isPaused: false,
          }),
        ),
        del: vi.fn(),
        setex: vi.fn(),
      };
      const cluster = { getSourceProducers: vi.fn().mockReturnValue([]) };
      const stateRepo = { get: vi.fn().mockResolvedValue({ seatCount: 15 }) };

      const localApp = Fastify();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await localApp.register(
        createInternalRoutes({
          roomManager: {
            getRoom: vi.fn().mockReturnValue(cluster),
            getRoomCount: vi.fn(),
            state: stateRepo,
          } as any,
          roomRegistry: createMockRoomRegistry() as any,
          pipeManager: createMockPipeManager() as any,
          cascadeRelay: null,
          cascadeCoordinator: null,
          io: null,
          seatRepository: seatRepo as any,
          redis: redisMock as any,
        }),
      );
      await localApp.ready();

      const res = await localApp.inject({
        method: "GET",
        url: "/internal/room/room-1/snapshot?seatCount=15",
        headers: { "x-internal-key": "test-internal-key-12345678" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.seats).toEqual([
        { seatIndex: 0, userId: 10, isMuted: false },
        { seatIndex: 2, userId: 20, isMuted: true },
      ]);
      expect(body.lockedSeats).toEqual([1]);
      expect(body.seatCount).toBe(15);
      expect(body.musicPlayer).toEqual(
        expect.objectContaining({ userId: 10, title: "Track" }),
      );
      await localApp.close();
    });
  });
});
