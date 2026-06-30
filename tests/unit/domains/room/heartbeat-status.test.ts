import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock heavy / env-bound modules BEFORE importing RoomManager ─────
vi.mock("@src/config/index.js", () => ({
  config: {
    INSTANCE_ID: "test-instance",
    AWS_REGION: "ap-south-1",
    PUBLIC_IP: "1.2.3.4",
    MEDIASOUP_ANNOUNCED_IP: "1.2.3.4",
    PORT: 3030,
  },
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { roomsActive: { set: vi.fn() } },
}));

// Avoid pulling mediasoup / Redis-Lua into the heartbeat unit test.
vi.mock("@src/domains/media/roomMediaCluster.js", () => ({
  RoomMediaCluster: class {},
}));
vi.mock("@src/domains/media/activeSpeaker.js", () => ({
  ActiveSpeakerDetector: class {},
}));
vi.mock("./roomState.js", () => ({
  RoomStateRepository: class {
    save = vi.fn();
    delete = vi.fn();
  },
}));

import { RoomManager } from "@src/domains/room/roomManager.js";

// ─── Stubs ──────────────────────────────────────────────────────────

function makeManager(present: number, isOwner = true) {
  const statusCoalescer = { submit: vi.fn(), flushNow: vi.fn(), forget: vi.fn() };
  const presenceTracker = {
    reconcile: vi.fn(async () => present),
  };
  const roomRegistry = {
    refreshOwnership: vi.fn(async () => {}),
    isOwner: vi.fn(async () => isOwner),
  };
  // realtime-17: the heartbeat must only call evaluate when this instance owns
  // the Room. Returns the unchanged "interactive" mode (no flip) so the submit
  // shape is unaffected when it IS called.
  const roomModeService = { evaluate: vi.fn(async () => "interactive") };

  const workerManager = { setOnWorkerDied: vi.fn() } as never;
  const redis = { defineCommand: vi.fn() } as never;
  const io = {} as never;
  const laravel = { updateRoomStatus: vi.fn() } as never;

  const manager = new RoomManager(
    workerManager,
    redis,
    io,
    laravel,
    statusCoalescer as never,
  );

  // Heartbeat iterates the private rooms map; seed one owned Room.
  (manager as unknown as { rooms: Map<string, unknown> }).rooms.set("r1", {});
  manager.setRoomRegistry(roomRegistry as never);
  manager.setRoomModeService(roomModeService as never);
  manager.setPresenceTracker(presenceTracker as never);

  return { manager, statusCoalescer, presenceTracker, roomRegistry, roomModeService };
}

const HEARTBEAT_MS = 30_000;

describe("RoomManager ownership heartbeat → coalesced Laravel keep-alive (realtime-02)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits a coalesced is_live keep-alive for an owned Room with present users", async () => {
    const { manager, statusCoalescer, presenceTracker } = makeManager(3);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    // The heartbeat reconciles presence (refreshes the Redis room:state TTL) and
    // then keeps the Laravel-side activity fresh — this is what keeps a >24h idle
    // broadcast tracked rather than going stale.
    expect(presenceTracker.reconcile).toHaveBeenCalledWith("r1");
    expect(statusCoalescer.submit).toHaveBeenCalledWith("r1", {
      is_live: true,
      participant_count: 3,
      mode: "interactive",
      hosting_region: "ap-south-1",
      hosting_ip: "1.2.3.4",
      hosting_port: 3030,
    });

    manager.stopOwnershipHeartbeat();
  });

  it("realtime-17: the owner evaluates mode for a populated Room", async () => {
    const { manager, roomModeService } = makeManager(3, /* isOwner */ true);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomModeService.evaluate).toHaveBeenCalledWith("r1", 3);
    manager.stopOwnershipHeartbeat();
  });

  it("realtime-17: a NON-owner never evaluates mode, but still reconciles presence/TTL", async () => {
    const { manager, statusCoalescer, presenceTracker, roomModeService } =
      makeManager(3, /* isOwner */ false);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    // No mode flip from an edge instance — that is the split-brain this fixes.
    expect(roomModeService.evaluate).not.toHaveBeenCalled();
    // Presence/TTL healing is unconditional: the submit still fires, sans mode.
    expect(presenceTracker.reconcile).toHaveBeenCalledWith("r1");
    expect(statusCoalescer.submit).toHaveBeenCalledWith("r1", {
      is_live: true,
      participant_count: 3,
      hosting_region: "ap-south-1",
      hosting_ip: "1.2.3.4",
      hosting_port: 3030,
    });
    manager.stopOwnershipHeartbeat();
  });

  it("does NOT submit if the Room closed while its reconcile was in flight (no resurrection)", async () => {
    // Defer reconcile's resolution so we can simulate closeRoom landing first.
    let resolveReconcile: (n: number) => void = () => {};
    const statusCoalescer = { submit: vi.fn(), flushNow: vi.fn(), forget: vi.fn() };
    const presenceTracker = {
      reconcile: vi.fn(() => new Promise<number>((r) => (resolveReconcile = r))),
    };
    const roomRegistry = { refreshOwnership: vi.fn(async () => {}) };

    const manager = new RoomManager(
      { setOnWorkerDied: vi.fn() } as never,
      { defineCommand: vi.fn() } as never,
      {} as never,
      { updateRoomStatus: vi.fn() } as never,
      statusCoalescer as never,
    );
    const rooms = (manager as unknown as { rooms: Map<string, unknown> }).rooms;
    rooms.set("r1", {});
    manager.setRoomRegistry(roomRegistry as never);
    manager.setPresenceTracker(presenceTracker as never);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); // fires reconcile (still pending)
    expect(presenceTracker.reconcile).toHaveBeenCalledWith("r1");

    // closeRoom raced ahead: Room removed from the map before reconcile resolves.
    rooms.delete("r1");
    resolveReconcile(3); // present>0 — would resurrect without the guard
    await vi.advanceTimersByTimeAsync(0);

    expect(statusCoalescer.submit).not.toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });

  it("realtime-17: an ownership-check error is contained — no flip, presence submit still fires", async () => {
    const { manager, statusCoalescer, roomModeService, roomRegistry } =
      makeManager(3, /* isOwner */ true);
    // Redis blip on the ownership read: must NOT abort the presence/TTL submit.
    roomRegistry.isOwner.mockRejectedValueOnce(new Error("redis down"));

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomModeService.evaluate).not.toHaveBeenCalled();
    expect(statusCoalescer.submit).toHaveBeenCalledWith("r1", {
      is_live: true,
      participant_count: 3,
      hosting_region: "ap-south-1",
      hosting_ip: "1.2.3.4",
      hosting_port: 3030,
    });
    manager.stopOwnershipHeartbeat();
  });

  it("keep-alive reflects an emptied Room as not-live with nulled hosting", async () => {
    const { manager, statusCoalescer } = makeManager(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(statusCoalescer.submit).toHaveBeenCalledWith("r1", {
      is_live: false,
      participant_count: 0,
      hosting_region: null,
      hosting_ip: null,
      hosting_port: null,
    });

    manager.stopOwnershipHeartbeat();
  });
});
