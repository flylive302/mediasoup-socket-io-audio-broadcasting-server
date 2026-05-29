import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    INSTANCE_ID: "test-instance",
    AWS_REGION: "us-east-1",
    CASCADE_ENABLED: true,
    PUBLIC_IP: "10.0.0.1",
    PORT: 3030,
    INTERNAL_API_KEY: "test-key",
  },
}));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { reversePipeSetup: { inc: vi.fn() } },
}));

import { CascadeCoordinator } from "@src/domains/cascade/cascade-coordinator.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

function createCoordinator(laravelOverride?: { getCascadeInfo?: ReturnType<typeof vi.fn> }) {
  const laravelClient = {
    getCascadeInfo: vi.fn().mockResolvedValue({ is_live: false }),
    ...laravelOverride,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cascadeRelay = { registerRemote: vi.fn(), cleanupRoom: vi.fn() } as any;

  return new CascadeCoordinator(
    {} as never,
    {} as never,
    {} as never,
    laravelClient,
    cascadeRelay,
    mockLogger,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("CascadeCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("isEdgeRoom returns false for an unregistered room", () => {
    expect(createCoordinator().isEdgeRoom("unknown-room")).toBe(false);
  });

  it("shared originUrls reference: join populates → fetchOriginParticipants uses the right URL", async () => {
    const laravelClient = {
      getCascadeInfo: vi.fn().mockResolvedValue({
        is_live: true,
        hosting_region: "eu-west-1",
        hosting_ip: "10.1.2.3",
        hosting_port: 3030,
      }),
    };

    const coordinator = createCoordinator({ getCascadeInfo: laravelClient.getCascadeInfo });

    const capturedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        if (url.includes("/internal/health")) {
          return Promise.resolve({ ok: true, json: async () => ({ instanceId: "origin-1" }) });
        }
        // edge-registered notify + participants
        return Promise.resolve({ ok: true, json: async () => ({ participants: [] }) });
      }),
    );

    await coordinator.handleCrossRegionJoin("room-cascade");

    expect(coordinator.isEdgeRoom("room-cascade")).toBe(true);

    await coordinator.fetchOriginParticipants("room-cascade");

    expect(capturedUrls.some((u) => u.includes("10.1.2.3") && u.includes("participants"))).toBe(true);
  });

  it("cleanup clears edge state so isEdgeRoom returns false afterwards", async () => {
    const laravelClient = {
      getCascadeInfo: vi.fn().mockResolvedValue({
        is_live: true,
        hosting_region: "eu-west-1",
        hosting_ip: "10.1.2.3",
        hosting_port: 3030,
      }),
    };
    const coordinator = createCoordinator({ getCascadeInfo: laravelClient.getCascadeInfo });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instanceId: "origin-1" }) }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (coordinator as any).pipeManager = { closePipes: vi.fn().mockResolvedValue(undefined) };

    await coordinator.handleCrossRegionJoin("room-cleanup");
    expect(coordinator.isEdgeRoom("room-cleanup")).toBe(true);

    await coordinator.cleanup("room-cleanup");

    expect(coordinator.isEdgeRoom("room-cleanup")).toBe(false);
  });
});
