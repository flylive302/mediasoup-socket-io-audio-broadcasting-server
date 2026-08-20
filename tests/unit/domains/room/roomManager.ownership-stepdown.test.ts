/**
 * aws-production/23 — the heartbeat consumes the refresh result: reclaim is
 * metered, loss forces an explicit STEP-DOWN instead of a silent split brain.
 *
 * B1 walk-through this proves: owner stalls >90s → TTL lapses → a rival's
 * join-time SETNX wins → the woken owner's next heartbeat refresh returns
 * "lost" → the owner steps down (stops its HLS publisher, drops its cached
 * ownership read, meters the transfer) rather than continuing to act as a
 * second origin. Before this ticket the refresh result was discarded — the
 * stale owner produced blind until the room died.
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
  opts: { isEdgeRoom?: boolean } = {},
) {
  const statusCoalescer = { submit: vi.fn(), flushNow: vi.fn(), forget: vi.fn() };
  const presenceTracker = { reconcile: vi.fn(async () => 3) };
  const roomRegistry = {
    refreshOwnership: vi.fn(async () => refreshResult),
    // 38-D: held/reclaimed refreshes also re-register origin info.
    registerOrigin: vi.fn(async () => undefined),
    isOwner: vi.fn(async () => refreshResult !== "lost"),
    forgetOwnerCache: vi.fn(),
  };
  const roomModeService = { evaluate: vi.fn(async () => "interactive") };
  const broadcastClosed = vi.fn();

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

  manager.setBroadcastClosedHook(broadcastClosed);

  return { manager, roomRegistry, roomModeService, broadcastClosed };
}

const HEARTBEAT_MS = 30_000;

describe("RoomManager heartbeat — step-down on ownership loss (aws-production/23)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("held: no transfer metric, no step-down", async () => {
    const { manager, broadcastClosed } = makeManager("held");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(ownershipTransfersInc).not.toHaveBeenCalled();
    expect(broadcastClosed).not.toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });

  it("origin rooms request the reclaim branch; the refresh is not a blind no-op", async () => {
    const { manager, roomRegistry } = makeManager("held");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomRegistry.refreshOwnership).toHaveBeenCalledWith(
      "r1",
      "test-instance",
      { allowReclaim: true },
    );
    manager.stopOwnershipHeartbeat();
  });

  it("reclaimed (stall, no rival): metered as a self-heal, owner keeps working", async () => {
    const { manager, broadcastClosed, roomModeService } =
      makeManager("reclaimed");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(ownershipTransfersInc).toHaveBeenCalledWith({ kind: "reclaimed" });
    expect(broadcastClosed).not.toHaveBeenCalled();
    // Still the owner — origin duties (mode evaluation) continue.
    expect(roomModeService.evaluate).toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });

  it("lost (rival claimed during the stall): explicit step-down — publisher stopped, cache dropped, transfer metered", async () => {
    const { manager, roomRegistry, broadcastClosed, roomModeService } =
      makeManager("lost");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    // The three step-down effects: no second HLS origin, no stale cached
    // "owner=true" window, and the transfer is visible to alarms.
    expect(broadcastClosed).toHaveBeenCalledWith("r1");
    expect(roomRegistry.forgetOwnerCache).toHaveBeenCalledWith("r1");
    expect(ownershipTransfersInc).toHaveBeenCalledWith({
      kind: "stepped_down",
    });
    // And no authoritative writes: the owns-gate reads false → no mode flip.
    expect(roomModeService.evaluate).not.toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });

  it("cascade EDGE rooms neither reclaim nor step down — 'lost' is their steady state", async () => {
    const { manager, roomRegistry, broadcastClosed } = makeManager("lost", {
      isEdgeRoom: true,
    });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(roomRegistry.refreshOwnership).toHaveBeenCalledWith(
      "r1",
      "test-instance",
      { allowReclaim: false },
    );
    expect(broadcastClosed).not.toHaveBeenCalled();
    expect(ownershipTransfersInc).not.toHaveBeenCalled();
    manager.stopOwnershipHeartbeat();
  });
});
