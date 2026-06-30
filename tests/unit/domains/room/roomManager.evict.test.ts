import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { roomsActive: { set: vi.fn() } },
}));

vi.mock("@src/config/index.js", () => ({
  config: { INSTANCE_ID: "self" },
}));

import { RoomManager } from "@src/domains/room/roomManager.js";

function makeRoomManager() {
  const workerManager = { setOnWorkerDied: vi.fn() } as any;
  const redis = {} as any;
  const io = {} as any;
  const laravelClient = {} as any;
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

describe("RoomManager.evictLocalRoom", () => {
  let rm: RoomManager;
  let registry: {
    cleanup: ReturnType<typeof vi.fn>;
    forgetOwnerCache: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    rm = makeRoomManager();
    registry = {
      cleanup: vi.fn().mockResolvedValue(undefined),
      forgetOwnerCache: vi.fn(),
    };
    // The instance has a registry bound (as in prod) — eviction must still not
    // touch it, because an edge/ghost does not own the CAS key.
    rm.setRoomRegistry(registry as any);
  });

  function injectCluster(roomId: string) {
    const cluster = { close: vi.fn().mockResolvedValue(undefined) };
    (rm as any).rooms.set(roomId, cluster);
    return cluster;
  }

  it("closes the cluster and removes it from the local map", async () => {
    const cluster = injectCluster("room-1");

    await rm.evictLocalRoom("room-1");

    expect(cluster.close).toHaveBeenCalledOnce();
    expect(rm.getRoom("room-1")).toBeUndefined();
    expect(rm.getRoomCount()).toBe(0);
  });

  it("does NOT release the CAS ownership key (no roomRegistry.cleanup)", async () => {
    injectCluster("room-1");

    await rm.evictLocalRoom("room-1");

    // Critical safety property: an edge/ghost eviction must never release the
    // real origin's ownership claim.
    expect(registry.cleanup).not.toHaveBeenCalled();
    // realtime-17: it MUST, however, drop the cache-only entry so it can't leak.
    expect(registry.forgetOwnerCache).toHaveBeenCalledWith("room-1");
  });

  it("is a no-op when the room is not present locally", async () => {
    await expect(rm.evictLocalRoom("missing")).resolves.toBeUndefined();
    expect(registry.cleanup).not.toHaveBeenCalled();
  });
});
