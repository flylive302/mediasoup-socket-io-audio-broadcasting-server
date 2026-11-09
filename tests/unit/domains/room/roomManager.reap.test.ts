import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { roomsActive: { set: vi.fn() } },
}));

const mockConfig = vi.hoisted(() => ({
  INSTANCE_ID: "self",
  AWS_REGION: "ap-south-1",
  PORT: 3030,
  VIDEO_PLAYER_ENABLED: false,
}));
vi.mock("@src/config/index.js", () => ({ config: mockConfig }));

vi.mock("@src/domains/seat/seat.owner.js", () => ({
  clearRoomOwner: vi.fn(),
}));

import { RoomManager } from "@src/domains/room/roomManager.js";
import { clearRoomOwner } from "@src/domains/seat/seat.owner.js";

function makeRoomManager() {
  const workerManager = { setOnWorkerDied: vi.fn() } as any;
  const redis = { del: vi.fn().mockResolvedValue(2) } as any;
  const emit = vi.fn();
  const io = { to: vi.fn(() => ({ emit })) } as any;
  const laravelClient = {} as any;
  const statusCoalescer = {
    flushNow: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn(),
  } as any;
  const seatRepository = {
    clearRoom: vi.fn().mockResolvedValue(undefined),
  } as any;
  const rm = new RoomManager(
    workerManager,
    redis,
    io,
    laravelClient,
    statusCoalescer,
    seatRepository,
  );
  const presenceTracker = { forget: vi.fn() } as any;
  rm.setPresenceTracker(presenceTracker);
  const registry = { cleanup: vi.fn().mockResolvedValue(undefined) } as any;
  rm.setRoomRegistry(registry);
  return {
    rm,
    redis,
    io,
    emit,
    statusCoalescer,
    seatRepository,
    presenceTracker,
    registry,
  };
}

describe("RoomManager.closeRoom orphan reap (realtime-08 AC4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reaps shared state and tells clients when the Room is an orphan (no local cluster, state present)", async () => {
    const h = makeRoomManager();
    const stateRepo = {
      get: vi.fn().mockResolvedValue({ id: "orphan", mode: "broadcast" }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    (h.rm as any).stateRepo = stateRepo;

    await h.rm.closeRoom("orphan", "region_died");

    // Clients are told.
    expect(h.io.to).toHaveBeenCalledWith("orphan");
    expect(h.emit).toHaveBeenCalledWith(
      "room:closed",
      expect.objectContaining({ roomId: "orphan", reason: "region_died" }),
    );
    // Laravel is marked not-live immediately (flushNow, not buffered).
    expect(h.statusCoalescer.flushNow).toHaveBeenCalledWith(
      "orphan",
      expect.objectContaining({ is_live: false, participant_count: 0 }),
    );
    // Shared state is cleaned up.
    expect(stateRepo.delete).toHaveBeenCalledWith("orphan");
    expect(h.seatRepository.clearRoom).toHaveBeenCalledWith("orphan");
    // Must NOT release the CAS owner key: it's an unconditional DEL and this
    // reap runs for a non-local room — the orphan's key expires via its own TTL.
    expect(h.registry.cleanup).not.toHaveBeenCalled();
    expect(clearRoomOwner).toHaveBeenCalledWith("orphan");
    expect(h.presenceTracker.forget).toHaveBeenCalledWith("orphan");
    expect(h.statusCoalescer.forget).toHaveBeenCalledWith("orphan");
  });

  it("is a quiet no-op when the state key is already gone (Room already closed normally)", async () => {
    const h = makeRoomManager();
    const stateRepo = {
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    (h.rm as any).stateRepo = stateRepo;

    await h.rm.closeRoom("already-gone", "inactivity");

    expect(h.emit).not.toHaveBeenCalled();
    expect(h.statusCoalescer.flushNow).not.toHaveBeenCalled();
    expect(stateRepo.delete).not.toHaveBeenCalled();
  });
});

describe("RoomManager — Room Video keys die with the Room (room-video-player/03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.VIDEO_PLAYER_ENABLED = true;
  });

  const videoKeys = (roomId: string) => [`room:${roomId}:videoPlayer`, `room:${roomId}:videoState`];

  it("closeRoom on a local Room deletes both video keys", async () => {
    const h = makeRoomManager();
    (h.rm as any).stateRepo = { delete: vi.fn().mockResolvedValue(undefined) };
    (h.rm as any).rooms.set("r1", { close: vi.fn().mockResolvedValue(undefined) });

    await h.rm.closeRoom("r1", "host_left");

    expect(h.redis.del).toHaveBeenCalledWith(...videoKeys("r1"));
  });

  it("an orphan reap deletes both video keys", async () => {
    const h = makeRoomManager();
    (h.rm as any).stateRepo = {
      get: vi.fn().mockResolvedValue({ id: "orphan" }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await h.rm.closeRoom("orphan", "region_died");

    expect(h.redis.del).toHaveBeenCalledWith(...videoKeys("orphan"));
  });

  it("a failing video DEL never aborts the close", async () => {
    const h = makeRoomManager();
    h.redis.del.mockRejectedValue(new Error("redis down"));
    (h.rm as any).stateRepo = { delete: vi.fn().mockResolvedValue(undefined) };
    (h.rm as any).rooms.set("r1", { close: vi.fn().mockResolvedValue(undefined) });

    await expect(h.rm.closeRoom("r1", "host_left")).resolves.toBeUndefined();
    expect(clearRoomOwner).toHaveBeenCalledWith("r1");
  });

  it("flag absent: closing never touches the video keys", async () => {
    mockConfig.VIDEO_PLAYER_ENABLED = false;
    const h = makeRoomManager();
    (h.rm as any).stateRepo = { delete: vi.fn().mockResolvedValue(undefined) };
    (h.rm as any).rooms.set("r1", { close: vi.fn().mockResolvedValue(undefined) });

    await h.rm.closeRoom("r1", "host_left");

    expect(h.redis.del).not.toHaveBeenCalledWith(...videoKeys("r1"));
  });
});
