import { beforeEach, describe, expect, it, vi } from "vitest";

// room-battery-perf/05: doCreateRoom must be create-if-absent on room:state.
// The state key lives in the per-REGION shared Redis, so a second instance in
// the region creating its local cluster (same-region cascade edge) must never
// clobber the origin's live participantCount/seatCount/seatCountSource back
// to defaults — that reset reopened the "default" seat-count claim window.

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { roomsActive: { set: vi.fn() } },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    INSTANCE_ID: "self",
    AWS_REGION: "test-region",
    PUBLIC_IP: "1.2.3.4",
    PORT: 3030,
  },
}));

vi.mock("@src/domains/media/roomMediaCluster.js", () => ({
  RoomMediaCluster: class {
    audioObserver = null;
    router = { rtpCapabilities: {} };
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    setActiveSpeakerDetector = vi.fn();
  },
}));

vi.mock("@src/domains/media/activeSpeaker.js", () => ({
  ActiveSpeakerDetector: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

import { RoomManager } from "@src/domains/room/roomManager.js";

function makeRoomManager() {
  const workerManager = { setOnWorkerDied: vi.fn() } as any;
  const redis = {} as any;
  const io = {} as any;
  const laravelClient = {
    updateRoomStatus: vi.fn().mockResolvedValue(undefined),
  } as any;
  const statusCoalescer = { forget: vi.fn() } as any;
  const rm = new RoomManager(
    workerManager,
    redis,
    io,
    laravelClient,
    statusCoalescer,
  );
  return rm;
}

describe("RoomManager room-state creation (room-battery-perf/05)", () => {
  let rm: RoomManager;
  let stateRepo: { get: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    rm = makeRoomManager();
    stateRepo = {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };
    (rm as any).stateRepo = stateRepo;
  });

  it("writes default state (source 'default') when no room:state exists", async () => {
    await rm.getOrCreateRoom("room-1");

    expect(stateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "room-1",
        seatCount: 15,
        seatCountSource: "default",
        participantCount: 0,
      }),
    );
  });

  it("preserves existing room:state (does NOT clobber the origin's live state)", async () => {
    stateRepo.get.mockResolvedValue({
      id: "room-1",
      status: "ACTIVE",
      participantCount: 7,
      seatCount: 25,
      seatCountSource: "laravel",
      mode: "interactive",
      createdAt: 1,
      lastActivityAt: 2,
    });

    await rm.getOrCreateRoom("room-1");

    expect(stateRepo.save).not.toHaveBeenCalled();
  });
});
