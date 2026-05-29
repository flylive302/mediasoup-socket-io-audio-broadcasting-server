import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({ config: { INSTANCE_ID: "test-instance", AWS_REGION: "us-east-1" } }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    reversePipeSetup: { inc: vi.fn() },
  },
}));

import { CascadeCoordinator } from "@src/domains/cascade/cascade-coordinator.js";

// ─── Helpers ─────────────────────────────────────────────────────────

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function createCoordinator() {
  return new CascadeCoordinator(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    mockLogger,
  );
}

function createMockProducer(id = "edge-prod-1") {
  const handlers = new Map<string, () => void>();
  return {
    id,
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    _fire: (event: string) => handlers.get(event)?.(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("CascadeCoordinator.reactOnPipeClose", () => {
  let coordinator: CascadeCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator = createCoordinator();
  });

  it("evicts the pipedProducers cache entry when transportclose fires", () => {
    const roomMap = new Map<string, unknown>();
    roomMap.set("origin-prod-1", { edgeProducerId: "edge-prod-1", transport: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (coordinator as any).pipedProducers.set("room-1", roomMap);

    const producer = createMockProducer("edge-prod-1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (coordinator as any).reactOnPipeClose(producer, "room-1", "origin-prod-1");
    producer._fire("transportclose");

    expect(roomMap.has("origin-prod-1")).toBe(false);
  });

  it("is a no-op when transportclose fires for an already-absent entry", () => {
    const roomMap = new Map<string, unknown>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (coordinator as any).pipedProducers.set("room-1", roomMap);

    const producer = createMockProducer("edge-prod-1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (coordinator as any).reactOnPipeClose(producer, "room-1", "origin-prod-1");
    producer._fire("transportclose");

    // Map.delete on a missing key is safe — no throw, map stays empty
    expect(roomMap.size).toBe(0);
  });
});
