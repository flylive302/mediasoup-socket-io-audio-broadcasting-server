import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-id",
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
    // The join GATE reads the room-block mirror; these tests supply a Redis
    // that rejects, so the repository's fail-open catch path runs and counts
    // the failure. Without this the counter is undefined and the GATE throws.
    roomBlockMirror: { inc: vi.fn() },
  },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    INSTANCE_ID: "self",
    PUBLIC_IP: "1.2.3.4",
    PORT: 3030,
    AWS_REGION: "us-east-1",
    MEDIASOUP_ANNOUNCED_IP: null,
    SEAT_RETENTION_GRACE_MS: 45_000,
  },
}));

const emitToRoomMock = vi.fn();
vi.mock("@src/shared/room-emit.js", () => ({
  emitToRoom: (...args: unknown[]) => emitToRoomMock(...args),
}));

vi.mock("@src/domains/seat/index.js", () => ({
  setRoomOwner: vi.fn(),
}));

vi.mock("@src/domains/audio-player/index.js", () => ({
  getMusicPlayerState: vi.fn().mockResolvedValue(null),
}));

vi.mock("@src/domains/room/room-leave.js", () => ({
  performRoomLeave: vi.fn().mockResolvedValue(undefined),
}));

import { joinRoomHandler } from "@src/domains/room/handlers/join-room.handler.js";

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: "Test User",
    phone: "+1234567890",
    email: "test@example.com",
    date_of_birth: "1990-01-01",
    signature: "sig",
    avatar: "avatar.jpg",
    frame_id: null,
    chat_bubble_id: null,
    entry_animation_id: null,
    data_card_id: null,
    mice_wave_id: null,
    slides_id: null,
    gender: 1,
    country: "US",
    wealth_xp: "100",
    charm_xp: "50",
    vip_level: 2,
    ...overrides,
  };
}

function createMockSocket(user = makeUser()) {
  return {
    id: "socket-self",
    data: { user },
    join: vi.fn(),
  } as any;
}

function createMockContext(remoteSockets: unknown[] = []) {
  return {
    io: {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue(remoteSockets),
      }),
      sockets: { sockets: new Map() },
    },
    roomManager: {
      getRoom: vi.fn().mockReturnValue(null),
      getOrCreateRoom: vi
        .fn()
        .mockResolvedValue({
          router: { rtpCapabilities: {} },
          getSourceProducers: vi.fn().mockReturnValue([]),
        }),
      state: {
        get: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        adjustParticipantCount: vi.fn().mockResolvedValue(1),
      },
    },
    clientManager: {
      getClient: vi.fn().mockReturnValue(null),
      setClientRoom: vi.fn(),
      getClientsInRoom: vi.fn().mockReturnValue([]),
    },
    seatRepository: {
      getSeats: vi.fn().mockResolvedValue([]),
      // realtime-22: default to no held seat (fresh join). Overridden per-test.
      reclaimSeat: vi.fn().mockResolvedValue({ reclaimed: false }),
    },
    cascadeCoordinator: null,
    roomRegistry: null,
    autoCloseService: {
      recordActivity: vi.fn().mockResolvedValue(undefined),
    },
    userRoomRepository: {
      setUserRoom: vi.fn().mockResolvedValue(undefined),
    },
    laravelClient: {
      updateRoomStatus: vi.fn().mockResolvedValue(undefined),
    },
    statusCoalescer: { submit: vi.fn() },
    redis: {},
    cascadeRelay: null,
  } as any;
}

describe("joinRoomHandler", () => {
  let socket: ReturnType<typeof createMockSocket>;
  let context: ReturnType<typeof createMockContext>;
  let handler: (payload: unknown, cb?: (r: unknown) => void) => Promise<void>;

  beforeEach(() => {
    socket = createMockSocket();
    context = createMockContext();
    vi.clearAllMocks();
    handler = joinRoomHandler(socket, context);
  });

  // ─── ADR 0017 / msab-join-gates 02: the block GATE ─────────────
  //
  // The only outcome a moderator actually experiences. Every other test in
  // the chain pins a link (Laravel payload keys → Redis key → getStatus
  // mapping); this pins the link that turns a mirrored block into a refused
  // join. Nothing covered it before, which is why "are blocks enforced on
  // the socket?" could not be answered from the test suite.
  //
  // NOTE the default context has `redis: {}` — `redis.ttl` is undefined, so
  // the GATE's read throws, fails OPEN, and every other test in this file
  // joins normally. These two cases supply a Redis that actually answers.
  describe("block GATE (ADR 0017)", () => {
    function contextWithBlockTtl(ttl: number) {
      const ctx = createMockContext();
      ctx.redis = { ttl: vi.fn().mockResolvedValue(ttl) };
      return ctx;
    }

    it("rejects a timed block with room_blocked and the remaining time", async () => {
      const ctx = contextWithBlockTtl(3600);
      const cb = vi.fn();

      await joinRoomHandler(socket, ctx)({ roomId: "room-1" }, cb);

      // Literal "room_blocked" — the frontend matches on this exact string,
      // so asserting Errors.ROOM_BLOCKED would not pin the contract.
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "room_blocked",
          permanent: false,
          remaining_seconds: 3600,
        }),
      );
    });

    it("rejects a permanent block (ttl -1) with permanent: true", async () => {
      const ctx = contextWithBlockTtl(-1);
      const cb = vi.fn();

      await joinRoomHandler(socket, ctx)({ roomId: "room-1" }, cb);

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "room_blocked",
          permanent: true,
          remaining_seconds: null,
        }),
      );
    });

    it("does not run the join EXECUTE stage for a blocked user", async () => {
      const ctx = contextWithBlockTtl(3600);

      await joinRoomHandler(socket, ctx)({ roomId: "room-1" }, vi.fn());

      expect(socket.join).not.toHaveBeenCalled();
    });

    it("lets a user through when the mirror reports no block (ttl -2)", async () => {
      const ctx = contextWithBlockTtl(-2);
      const cb = vi.fn();

      await joinRoomHandler(socket, ctx)({ roomId: "room-1" }, cb);

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });
  });

  describe("room:userJoined broadcast", () => {
    it("does not include phone or email", async () => {
      await handler({ roomId: "room-1" }, vi.fn());

      expect(emitToRoomMock).toHaveBeenCalledOnce();
      const [, , , payload] = emitToRoomMock.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        { user: Record<string, unknown> },
      ];
      expect(payload.user).not.toHaveProperty("phone");
      expect(payload.user).not.toHaveProperty("email");
    });

    it("includes date_of_birth", async () => {
      await handler({ roomId: "room-1" }, vi.fn());

      const [, , , payload] = emitToRoomMock.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        { user: Record<string, unknown> },
      ];
      expect(payload.user.date_of_birth).toBe("1990-01-01");
    });
  });

  describe("seat re-claim on rejoin (realtime-22)", () => {
    it("clears the held-seat marker via reclaimSeat on join", async () => {
      context.seatRepository.reclaimSeat = vi
        .fn()
        .mockResolvedValue({ reclaimed: true, seatIndex: 3, isMuted: false });
      const h = joinRoomHandler(socket, context);

      await h({ roomId: "room-1" }, vi.fn());

      expect(context.seatRepository.reclaimSeat).toHaveBeenCalledWith(
        "room-1",
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("broadcasts room:userJoined AND a seat:updated re-sync on reclaim (roster for late joiners, seat re-fill for clients that cleared it during the outage)", async () => {
      context.seatRepository.reclaimSeat = vi
        .fn()
        .mockResolvedValue({ reclaimed: true, seatIndex: 3, isMuted: true });
      const h = joinRoomHandler(socket, context);

      await h({ roomId: "room-1" }, vi.fn());

      expect(emitToRoomMock).toHaveBeenCalledTimes(2);
      const events = emitToRoomMock.mock.calls.map((c) => c[2]);
      expect(events).toContain("room:userJoined");
      expect(events).toContain("seat:updated");
      const seatCall = emitToRoomMock.mock.calls.find((c) => c[2] === "seat:updated")!;
      expect(seatCall[3]).toEqual({
        seatIndex: 3,
        userId: expect.any(Number),
        isMuted: true,
      });
    });

    it("a fresh join (no held seat) broadcasts room:userJoined", async () => {
      // Base mock returns { reclaimed: false }.
      await handler({ roomId: "room-1" }, vi.fn());
      expect(emitToRoomMock).toHaveBeenCalledOnce();
    });
  });

  describe("join snapshot", () => {
    it("includes date_of_birth for each existing participant", async () => {
      const remoteUser = makeUser({ id: 99, date_of_birth: "1985-05-15" });
      const ctx = createMockContext([
        { id: "remote-1", data: { user: remoteUser } },
      ]);
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        participants: Array<{ date_of_birth: string | null }>;
      };
      expect(result.participants).toHaveLength(1);
      expect(result.participants[0]?.date_of_birth).toBe("1985-05-15");
    });

    // dj-talk-over/01: existingProducers must list ALL of a client's
    // producers (mic AND music), each tagged with `source` — not one per
    // kind — so a joiner mid-music immediately hears both.
    it("lists both mic and music producers for a client, each with source", async () => {
      const remoteUser = makeUser({ id: 99 });
      const ctx = createMockContext([
        { id: "remote-1", data: { user: remoteUser } },
      ]);
      ctx.clientManager.getClientsInRoom = vi.fn().mockReturnValue([
        {
          socketId: "remote-1",
          userId: 99,
          isSpeaker: true,
          producers: new Map([
            ["mic", "prod-mic-99"],
            ["music", "prod-music-99"],
          ]),
        },
      ]);
      ctx.io.sockets.sockets = new Map([["remote-1", { connected: true }]]);
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        existingProducers: Array<{ producerId: string; userId: number; source: string }>;
      };
      expect(result.existingProducers).toHaveLength(2);
      expect(result.existingProducers).toEqual(
        expect.arrayContaining([
          { producerId: "prod-mic-99", userId: 99, source: "mic" },
          { producerId: "prod-music-99", userId: 99, source: "music" },
        ]),
      );
    });

    // Compat: a producer tracked under a pre-feature key still surfaces —
    // the registry itself defaults unset `source` to "mic" at produce time
    // (schemas.test.ts), so any entry the join snapshot sees already carries
    // a source key. This asserts the join-side plumbing doesn't drop it.
    it("surfaces a single mic-only entry with source when no music is playing", async () => {
      const remoteUser = makeUser({ id: 99 });
      const ctx = createMockContext([
        { id: "remote-1", data: { user: remoteUser } },
      ]);
      ctx.clientManager.getClientsInRoom = vi.fn().mockReturnValue([
        {
          socketId: "remote-1",
          userId: 99,
          isSpeaker: true,
          producers: new Map([["mic", "prod-mic-99"]]),
        },
      ]);
      ctx.io.sockets.sockets = new Map([["remote-1", { connected: true }]]);
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        existingProducers: Array<{ producerId: string; userId: number; source: string }>;
      };
      expect(result.existingProducers).toEqual([
        { producerId: "prod-mic-99", userId: 99, source: "mic" },
      ]);
    });

    // aws-production/38: a speaker connected through ANOTHER instance is
    // reverse-piped into this origin's source router (registerProducer) but
    // has no local clientManager entry, so the local-client loop alone never
    // surfaces them — an origin-side joiner would miss that speaker entirely.
    // The cluster's router-level list is authoritative (it is what
    // /internal/room/:id/producers serves to attaching edges) and must be
    // merged into the join snapshot.
    it("includes reverse-piped producers absent from local clients, and marks the owner as speaker", async () => {
      const edgeSpeaker = makeUser({ id: 77 });
      const ctx = createMockContext([
        { id: "remote-edge-77", data: { user: edgeSpeaker } },
      ]);
      ctx.roomManager.getOrCreateRoom = vi.fn().mockResolvedValue({
        router: { rtpCapabilities: {} },
        getSourceProducers: vi
          .fn()
          .mockReturnValue([
            { producerId: "prod-rp-77", userId: 77, kind: "audio", source: "mic" },
          ]),
      });
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        existingProducers: Array<{ producerId: string; userId: number; source: string }>;
        participants: Array<{ id: number; isSpeaker: boolean }>;
      };
      expect(result.existingProducers).toEqual([
        { producerId: "prod-rp-77", userId: 77, source: "mic" },
      ]);
      expect(result.participants.find((p) => p.id === 77)?.isSpeaker).toBe(true);
    });

    // aws-production/38: producers already surfaced by the local-client loop
    // must not be duplicated by the router-level merge.
    it("does not duplicate producers present both locally and on the cluster", async () => {
      const remoteUser = makeUser({ id: 99 });
      const ctx = createMockContext([
        { id: "remote-1", data: { user: remoteUser } },
      ]);
      ctx.clientManager.getClientsInRoom = vi.fn().mockReturnValue([
        {
          socketId: "remote-1",
          userId: 99,
          isSpeaker: true,
          producers: new Map([["mic", "prod-mic-99"]]),
        },
      ]);
      ctx.io.sockets.sockets = new Map([["remote-1", { connected: true }]]);
      ctx.roomManager.getOrCreateRoom = vi.fn().mockResolvedValue({
        router: { rtpCapabilities: {} },
        getSourceProducers: vi
          .fn()
          .mockReturnValue([
            { producerId: "prod-mic-99", userId: 99, kind: "audio", source: "mic" },
          ]),
      });
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        existingProducers: Array<{ producerId: string; userId: number; source: string }>;
      };
      expect(result.existingProducers).toEqual([
        { producerId: "prod-mic-99", userId: 99, source: "mic" },
      ]);
    });

    // aws-production/38: a stale router-level producer owned by the joining
    // user (e.g. rejoin within the seat grace window before the old
    // transport closes) must never be handed back to them for self-consume.
    it("excludes the joining user's own producers from the router-level merge", async () => {
      const ctx = createMockContext([]);
      ctx.roomManager.getOrCreateRoom = vi.fn().mockResolvedValue({
        router: { rtpCapabilities: {} },
        getSourceProducers: vi
          .fn()
          .mockReturnValue([
            { producerId: "prod-stale-42", userId: 42, kind: "audio", source: "mic" },
          ]),
      });
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-1" }, cb);

      const result = cb.mock.calls[0]?.[0] as {
        existingProducers: Array<{ producerId: string; userId: number; source: string }>;
      };
      expect(result.existingProducers).toEqual([]);
    });
  });

  // Ghost-cluster guard: a pre-existing local cluster must be backed by valid
  // ownership (origin) or edge registration; otherwise it is a leftover that
  // would short-circuit ownership resolution and cause same-region split-brain.
  describe("ghost-cluster guard", () => {
    function makeGuardContext(opts: {
      owner: string | null;
      isEdgeRoom: boolean;
    }) {
      const ctx = createMockContext();
      // A leftover cluster is present locally.
      ctx.roomManager.getRoom = vi
        .fn()
        .mockReturnValue({ router: { rtpCapabilities: {} } });
      ctx.roomManager.evictLocalRoom = vi.fn().mockResolvedValue(undefined);
      ctx.roomRegistry = {
        getOwner: vi.fn().mockResolvedValue(opts.owner),
        claimOwnership: vi.fn().mockResolvedValue({ won: true, owner: "self" }),
        registerOrigin: vi.fn().mockResolvedValue(undefined),
        refreshOwnership: vi.fn().mockResolvedValue(undefined),
      };
      ctx.cascadeCoordinator = {
        isEdgeRoom: vi.fn().mockReturnValue(opts.isEdgeRoom),
        handleCrossRegionJoin: vi.fn().mockResolvedValue({ isEdge: false }),
      };
      return ctx;
    }

    it("evicts a ghost cluster when another instance owns the room and we are not an edge", async () => {
      const ctx = makeGuardContext({
        owner: "other-instance",
        isEdgeRoom: false,
      });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).toHaveBeenCalledWith("room-1");
      // After eviction it must fall through to ownership resolution (re-claim CAS).
      expect(ctx.roomRegistry.claimOwnership).toHaveBeenCalledWith(
        "room-1",
        "self",
      );
    });

    it("evicts a ghost cluster when the ownership key is expired/unset and we are not an edge", async () => {
      const ctx = makeGuardContext({ owner: null, isEdgeRoom: false });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).toHaveBeenCalledWith("room-1");
    });

    it("keeps the cluster (no eviction) when this instance owns the room", async () => {
      const ctx = makeGuardContext({ owner: "self", isEdgeRoom: false });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).not.toHaveBeenCalled();
      // Owns it → no re-CAS churn.
      expect(ctx.roomRegistry.claimOwnership).not.toHaveBeenCalled();
    });

    it("keeps the cluster (no eviction) when this instance is a registered edge", async () => {
      const ctx = makeGuardContext({
        owner: "other-instance",
        isEdgeRoom: true,
      });
      const h = joinRoomHandler(socket, ctx);

      await h({ roomId: "room-1" }, vi.fn());

      expect(ctx.roomManager.evictLocalRoom).not.toHaveBeenCalled();
    });
  });

  // realtime-20: a cached edge cluster pointing at a dead/relocated origin
  // (host hard-killed before drain → never relayed room:closed) passes the
  // ghost-guard (isEdgeRoom is still true) but its origin snapshot fetches
  // blackhole. The join must detach the stale edge and re-resolve ownership
  // once — claiming origin locally — instead of serving a broken degraded join.
  describe("stale edge origin recovery", () => {
    const edgeCaps = { edge: true };
    const originCaps = { origin: true };

    function makeStaleEdgeContext(opts: {
      originParticipants: unknown;
      originSnapshot: unknown;
    }) {
      const ctx = createMockContext();
      let detached = false;
      const edgeCluster = {
        router: { rtpCapabilities: edgeCaps },
        getSourceProducers: vi.fn().mockReturnValue([]),
      };
      const originCluster = {
        router: { rtpCapabilities: originCaps },
        getSourceProducers: vi.fn().mockReturnValue([]),
      };

      // Edge cluster present until handleOriginClosed detaches it.
      ctx.roomManager.getRoom = vi.fn(() => (detached ? null : edgeCluster));
      ctx.roomManager.getOrCreateRoom = vi
        .fn()
        .mockResolvedValue(originCluster);
      ctx.roomManager.evictLocalRoom = vi.fn().mockResolvedValue(undefined);

      ctx.roomRegistry = {
        getOwner: vi.fn().mockResolvedValue("dead-origin"),
        // The dead origin's CAS key has expired → this instance wins the claim.
        claimOwnership: vi.fn().mockResolvedValue({ won: true, owner: "self" }),
        registerOrigin: vi.fn().mockResolvedValue(undefined),
        refreshOwnership: vi.fn().mockResolvedValue(undefined),
      };

      ctx.cascadeCoordinator = {
        isEdgeRoom: vi.fn(() => !detached),
        handleCrossRegionJoin: vi.fn().mockResolvedValue({ isEdge: false }),
        handleSameRegionEdge: vi.fn().mockResolvedValue({ isEdge: false }),
        fetchAndPipeExistingProducers: vi.fn().mockResolvedValue([]),
        fetchOriginParticipants: vi
          .fn()
          .mockResolvedValue(opts.originParticipants),
        fetchOriginRoomSnapshot: vi.fn().mockResolvedValue(opts.originSnapshot),
        handleOriginClosed: vi.fn(async () => {
          detached = true;
        }),
      };

      return { ctx, edgeCluster, originCluster };
    }

    it("detaches the stale edge and re-resolves to origin when the origin is unreachable", async () => {
      // Both participants AND snapshot null → origin unreachable.
      const { ctx } = makeStaleEdgeContext({
        originParticipants: null,
        originSnapshot: null,
      });
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-12" }, cb);

      expect(ctx.cascadeCoordinator.handleOriginClosed).toHaveBeenCalledWith(
        "room-12",
      );
      // Re-resolution claims origin locally (heals).
      expect(ctx.roomRegistry.claimOwnership).toHaveBeenCalledWith(
        "room-12",
        "self",
      );
      // Response carries the FINAL (origin) cluster's caps, not the dead edge's.
      const result = cb.mock.calls[0]?.[0] as {
        success: boolean;
        rtpCapabilities: unknown;
      };
      expect(result.success).toBe(true);
      expect(result.rtpCapabilities).toEqual(originCaps);
    });

    it("does NOT detach when the origin snapshot is reachable (happy edge path)", async () => {
      const { ctx } = makeStaleEdgeContext({
        originParticipants: [],
        originSnapshot: {
          seats: [],
          lockedSeats: [],
          seatCount: 15,
          musicPlayer: null,
        },
      });
      const h = joinRoomHandler(socket, ctx);
      const cb = vi.fn();

      await h({ roomId: "room-12" }, cb);

      expect(ctx.cascadeCoordinator.handleOriginClosed).not.toHaveBeenCalled();
      expect(ctx.roomRegistry.claimOwnership).not.toHaveBeenCalled();
      const result = cb.mock.calls[0]?.[0] as { rtpCapabilities: unknown };
      expect(result.rtpCapabilities).toEqual(edgeCaps);
    });
  });
});
