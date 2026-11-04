import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    giftLuckyResultLatencySeconds: { observe: vi.fn() },
  },
}));

import {
  luckyTapToEmitSeconds,
  observeLuckyResultLatency,
} from "@src/domains/gift/luckyLatency.js";
import { metrics } from "@src/infrastructure/metrics.js";

const NOW = 1_700_000_010_000;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("luckyTapToEmitSeconds (pure GATE)", () => {
  it("returns (now - tapped_at) / 1000 for a past tapped_at", () => {
    expect(luckyTapToEmitSeconds({ tapped_at: NOW - 1500 }, NOW)).toBe(1.5);
  });

  it("returns 0 for a tap stamped at the same millisecond", () => {
    expect(luckyTapToEmitSeconds({ tapped_at: NOW }, NOW)).toBe(0);
  });

  it("returns null for a future-dated tapped_at (cross-box skew) — negatives are skipped, not clamped", () => {
    expect(luckyTapToEmitSeconds({ tapped_at: NOW + 1 }, NOW)).toBeNull();
  });

  it.each([
    ["zero", { tapped_at: 0 }],
    ["negative", { tapped_at: -5 }],
    ["epoch seconds, not ms", { tapped_at: 1762300000 }],
    ["absent key", { multiplier: 2 }],
    ["string", { tapped_at: "1700000009000" }],
    ["null", { tapped_at: null }],
    ["NaN", { tapped_at: Number.NaN }],
    ["Infinity", { tapped_at: Number.POSITIVE_INFINITY }],
    ["boolean", { tapped_at: true }],
  ])("returns null for %s", (_label, payload) => {
    expect(luckyTapToEmitSeconds(payload, NOW)).toBeNull();
  });

  it.each([[null], [undefined], ["x"], [42]])("returns null for a non-object payload (%s)", (payload) => {
    expect(luckyTapToEmitSeconds(payload, NOW)).toBeNull();
  });
});

describe("observeLuckyResultLatency (REACT)", () => {
  it("observes the delta under the given path label", () => {
    observeLuckyResultLatency("inline", { tapped_at: NOW - 2000 }, NOW);
    observeLuckyResultLatency("queued", { tapped_at: NOW - 500 }, NOW);

    expect(metrics.giftLuckyResultLatencySeconds.observe).toHaveBeenNthCalledWith(1, { path: "inline" }, 2);
    expect(metrics.giftLuckyResultLatencySeconds.observe).toHaveBeenNthCalledWith(2, { path: "queued" }, 0.5);
  });

  it("does not observe when tapped_at is unusable", () => {
    observeLuckyResultLatency("inline", {}, NOW);
    observeLuckyResultLatency("queued", { tapped_at: NOW + 10 }, NOW);

    expect(metrics.giftLuckyResultLatencySeconds.observe).not.toHaveBeenCalled();
  });

  it("swallows a throwing histogram — never reaches the emit path", () => {
    vi.mocked(metrics.giftLuckyResultLatencySeconds.observe).mockImplementationOnce(() => {
      throw new Error("metrics fault");
    });

    expect(() => observeLuckyResultLatency("inline", { tapped_at: NOW - 1 }, NOW)).not.toThrow();
  });
});
