import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    CASCADE_ENABLED: true,
    AWS_REGION: "us-east-1",
    INSTANCE_ID: "self-instance",
    PUBLIC_IP: "10.0.0.1",
    PORT: 3030,
    INTERNAL_API_KEY: "test-key",
  },
}));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CrossRegionJoin } from "@src/domains/cascade/cross-region-join.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

function createJoin({
  laravelOverride,
  roomRegistryOverride,
}: {
  laravelOverride?: Partial<{ getCascadeInfo: ReturnType<typeof vi.fn> }>;
  roomRegistryOverride?: Partial<{ getOrigin: ReturnType<typeof vi.fn> }>;
} = {}) {
  const laravelClient = {
    getCascadeInfo: vi.fn().mockResolvedValue({ is_live: false }),
    ...laravelOverride,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const roomRegistry = {
    getOrigin: vi.fn().mockResolvedValue(null),
    ...roomRegistryOverride,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const cascadeRelay = {
    registerRemote: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const originSnapshot = {
    fetchOriginInstanceId: vi.fn().mockResolvedValue("origin-instance-1"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const edgePipeLifecycle = {
    notifyOriginEdgeRegistered: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const join = new CrossRegionJoin(
    roomRegistry,
    laravelClient,
    cascadeRelay,
    originSnapshot,
    mockLogger,
  );
  join.bindEdgePipeLifecycle(edgePipeLifecycle);

  return { join, laravelClient, roomRegistry, cascadeRelay, originSnapshot, edgePipeLifecycle };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("CrossRegionJoin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── isEdgeRoom / getOriginUrl ─────────────────────────────────────────

  it("isEdgeRoom returns false for an unregistered room", () => {
    const { join } = createJoin();
    expect(join.isEdgeRoom("unknown")).toBe(false);
  });

  it("getOriginUrl returns null for an unregistered room", () => {
    const { join } = createJoin();
    expect(join.getOriginUrl("unknown")).toBeNull();
  });

  it("detachRoom removes origin URL so isEdgeRoom becomes false", () => {
    const { join } = createJoin();
    // Manually prime the map via originUrls getter (writable internally)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (join as any)._originUrls.set("room-1", "http://origin:3030");
    expect(join.isEdgeRoom("room-1")).toBe(true);

    join.detachRoom("room-1");

    expect(join.isEdgeRoom("room-1")).toBe(false);
    expect(join.getOriginUrl("room-1")).toBeNull();
  });

  // ── handleCrossRegionJoin ─────────────────────────────────────────────

  describe("handleCrossRegionJoin", () => {
    it("returns {isEdge: false} when CASCADE_ENABLED is false", async () => {
      const { config } = await import("@src/config/index.js");
      const savedEnabled = config.CASCADE_ENABLED;
      (config as { CASCADE_ENABLED: boolean }).CASCADE_ENABLED = false;

      const { join } = createJoin();
      const result = await join.handleCrossRegionJoin("room-1");

      expect(result).toEqual({ isEdge: false });
      (config as { CASCADE_ENABLED: boolean }).CASCADE_ENABLED = savedEnabled;
    });

    it("returns {isEdge: false} when room is not live", async () => {
      const { join, laravelClient } = createJoin();
      laravelClient.getCascadeInfo.mockResolvedValue({ is_live: false });

      const result = await join.handleCrossRegionJoin("room-1");

      expect(result).toEqual({ isEdge: false });
    });

    it("returns {isEdge: false} when room is in the same region", async () => {
      const { join, laravelClient } = createJoin();
      laravelClient.getCascadeInfo.mockResolvedValue({
        is_live: true,
        hosting_region: "us-east-1", // same as selfRegion in mock config
        hosting_ip: "10.0.1.1",
        hosting_port: 3030,
      });

      const result = await join.handleCrossRegionJoin("room-1");

      expect(result).toEqual({ isEdge: false });
    });

    it("returns {isEdge: false} when hosting_ip/port missing", async () => {
      const { join, laravelClient } = createJoin();
      laravelClient.getCascadeInfo.mockResolvedValue({
        is_live: true,
        hosting_region: "eu-west-1",
        // no hosting_ip/port
      });

      const result = await join.handleCrossRegionJoin("room-1");

      expect(result).toEqual({ isEdge: false });
    });

    it("returns {isEdge: false} when origin instanceId cannot be fetched", async () => {
      const { join, laravelClient, originSnapshot } = createJoin();
      laravelClient.getCascadeInfo.mockResolvedValue({
        is_live: true,
        hosting_region: "eu-west-1",
        hosting_ip: "10.0.2.1",
        hosting_port: 3030,
      });
      originSnapshot.fetchOriginInstanceId.mockResolvedValue(null);

      const result = await join.handleCrossRegionJoin("room-1");

      expect(result).toEqual({ isEdge: false });
    });

    it("returns isEdge:true and registers the room when cross-region join succeeds", async () => {
      const { join, laravelClient, cascadeRelay, edgePipeLifecycle } = createJoin();
      laravelClient.getCascadeInfo.mockResolvedValue({
        is_live: true,
        hosting_region: "eu-west-1",
        hosting_ip: "10.0.2.1",
        hosting_port: 3030,
      });

      const result = await join.handleCrossRegionJoin("room-1");

      expect(result).toEqual({
        isEdge: true,
        originIp: "10.0.2.1",
        originPort: 3030,
        originRegion: "eu-west-1",
      });
      expect(join.isEdgeRoom("room-1")).toBe(true);
      expect(join.getOriginUrl("room-1")).toBe("http://10.0.2.1:3030");
      expect(cascadeRelay.registerRemote).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({ baseUrl: "http://10.0.2.1:3030" }),
      );
      expect(edgePipeLifecycle.notifyOriginEdgeRegistered).toHaveBeenCalledWith(
        "http://10.0.2.1:3030",
        "room-1",
      );
    });
  });

  // ── handleSameRegionEdge ──────────────────────────────────────────────

  describe("handleSameRegionEdge", () => {
    it("returns {isEdge: false} when CASCADE_ENABLED is false", async () => {
      const { config } = await import("@src/config/index.js");
      (config as { CASCADE_ENABLED: boolean }).CASCADE_ENABLED = false;

      const { join } = createJoin();
      const result = await join.handleSameRegionEdge("room-1", "owner-1");

      expect(result).toEqual({ isEdge: false });
      (config as { CASCADE_ENABLED: boolean }).CASCADE_ENABLED = true;
    });

    it("returns {isEdge: false} when origin never appears in registry", async () => {
      const { join, roomRegistry } = createJoin();
      roomRegistry.getOrigin.mockResolvedValue(null);

      const result = await join.handleSameRegionEdge("room-1", "owner-1");

      expect(result).toEqual({ isEdge: false });
    });

    it("returns isEdge:true and attaches when origin appears in registry", async () => {
      const { join, roomRegistry, cascadeRelay, edgePipeLifecycle } = createJoin();
      roomRegistry.getOrigin.mockResolvedValue({
        instanceId: "owner-1",
        ip: "10.0.3.1",
        port: 3030,
      });

      const result = await join.handleSameRegionEdge("room-1", "owner-1");

      expect(result).toEqual({
        isEdge: true,
        originIp: "10.0.3.1",
        originPort: 3030,
        originRegion: "us-east-1",
      });
      expect(join.isEdgeRoom("room-1")).toBe(true);
      expect(cascadeRelay.registerRemote).toHaveBeenCalled();
      expect(edgePipeLifecycle.notifyOriginEdgeRegistered).toHaveBeenCalled();
    });
  });

  // ── originUrls shared reference ───────────────────────────────────────

  it("exposes originUrls as a ReadonlyMap that reflects internal state", () => {
    const { join } = createJoin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (join as any)._originUrls.set("room-x", "http://origin-x:3030");
    expect(join.originUrls.get("room-x")).toBe("http://origin-x:3030");
  });
});
