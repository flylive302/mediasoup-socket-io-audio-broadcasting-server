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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ─── Tests ────────────────────────────────────────────────────────────

describe("CascadeCoordinator", () => {
  let coordinator: CascadeCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator = createCoordinator();
  });

  it("isEdgeRoom returns false for an unregistered room", () => {
    expect(coordinator.isEdgeRoom("unknown-room")).toBe(false);
  });
});
