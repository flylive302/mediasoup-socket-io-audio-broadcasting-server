/**
 * aws-production/38-D — the heartbeat keeps the `:origin` info key alive
 * alongside the CAS `:owner` claim.
 *
 * The prod failure this reproduces: `:origin` (24h TTL) is written only in the
 * join handler's claim branch, which a room living on its owner never
 * re-enters — while the CAS claim heartbeats forever. Any room alive >24h had
 * its origin info expire, so every join landing on the OTHER instance
 * exhausted the waitForOriginInfo poll and was refused ("another instance
 * owns it but cascade edge setup failed") — ~600 refused joins/day, masked by
 * the Sentry quota blackout until 2026-08-20. The fix: on a held/reclaimed
 * refresh the heartbeat re-registers origin info (registerOrigin re-creates
 * an expired key and preserves listenerCount on a live one).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const ownershipTransfersInc = vi.hoisted(() => vi.fn());
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    roomsActive: { set: vi.fn() },
    ownershipTransfers: { inc: ownershipTransfersInc },
  },
}));

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

function makeManager(
  refreshResult: "held" | "reclaimed" | "lost",
  opts: { isEdgeRoom?: boolean; registerOriginRejects?: boolean } = {},
) {
  const statusCoalescer = { submit: vi.fn(), flushNow: vi.fn(), forget: vi.fn() };
  const presenceTracker = { reconcile: vi.fn(async () => 3) };
  const roomRegistry = {
    refreshOwnership: vi.fn(async () => refreshResult),
    registerOrigin: opts.registerOriginRejects
      ? vi.fn(async () => {
          throw new Error("redis down");
        })
      : vi.fn(async () => undefined),
    isOwner: vi.fn(async () => refreshResult !== "lost"),
    forgetOwnerCache: vi.fn(),
  };
  const roomModeService = { evaluate: vi.fn(async () => "interactive") };

  const manager = new RoomManager(
    { setOnWorkerDied: vi.fn() } as never,
    { defineCommand: vi.fn() } as never,
    {} as never,
    { updateRoomStatus: vi.fn() } as never,
    statusCoalescer as never,
  );

  (manager as unknown as { rooms: Map<string, unknown> }).rooms.set("r1", {
    getResumedAudioProducerCount: () => 2,
  });
  if (opts.isEdgeRoom !== undefined) {
    manager.setCascadeServices(
      { isEdgeRoom: vi.fn(() => opts.isEdgeRoom) } as never,
      {} as never,
    );
  }
  manager.setRoomRegistry(roomRegistry as never);
  manager.setRoomModeService(roomModeService as never);
  manager.setPresenceTracker(presenceTracker as never);
  manager.setBroadcastClosedHook(vi.fn());

  return { manager, roomRegistry };
}

const HEARTBEAT_MS = 30_000;

const SELF_ORIGIN_INFO = {
  instanceId: "test-instance",
  ip: "1.2.3.4",
  port: 3030,
  listenerCount: 0,
};

describe("RoomManager heartbeat — :origin info refresh (aws-production/38-D)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("REPRO: held claim re-registers origin info — without this a >24h room's :origin expires and cross-instance joins are refused", async () => {
    const { manager, roomRegistry } = makeManager("held");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomRegistry.registerOrigin).toHaveBeenCalledWith(
      "r1",
      SELF_ORIGIN_INFO,
    );
    manager.stopOwnershipHeartbeat();
  });

  it("reclaimed claim ALSO re-registers — the reclaim path never wrote origin info", async () => {
    const { manager, roomRegistry } = makeManager("reclaimed");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomRegistry.registerOrigin).toHaveBeenCalledWith(
      "r1",
      SELF_ORIGIN_INFO,
    );
    manager.stopOwnershipHeartbeat();
  });

  it("lost claim does NOT register origin info — a stepped-down rival must not overwrite the real owner's info", async () => {
    const { manager, roomRegistry } = makeManager("lost");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomRegistry.registerOrigin).not.toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });

  it("cascade EDGE rooms do NOT register origin info — that would clobber the origin's ip/port with the edge's", async () => {
    const { manager, roomRegistry } = makeManager("held", { isEdgeRoom: true });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomRegistry.registerOrigin).not.toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });

  it("a registerOrigin failure is contained (REACT: logged, heartbeat keeps ticking)", async () => {
    const { manager, roomRegistry } = makeManager("held", {
      registerOriginRejects: true,
    });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    // Second tick still ran both refreshes — the rejection didn't kill the loop.
    expect(roomRegistry.refreshOwnership).toHaveBeenCalledTimes(2);
    expect(roomRegistry.registerOrigin).toHaveBeenCalledTimes(2);
    manager.stopOwnershipHeartbeat();
  });
});
