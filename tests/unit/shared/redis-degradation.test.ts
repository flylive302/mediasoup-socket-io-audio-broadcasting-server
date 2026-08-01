import { describe, it, expect, vi, beforeEach } from "vitest";

// platform-security 07: the shared Redis-degradation counter. The contract
// under test is not "does it count" — it is "can instrumentation ever change
// what the degrading call site returns". The answer must be no, under every
// failure mode of the metrics backend.

const inc = vi.fn();
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    redisDegradations: {
      inc: (...args: unknown[]) => inc(...args),
    },
  },
}));

import { recordRedisDegradation } from "@src/shared/redis-degradation.js";

describe("recordRedisDegradation", () => {
  beforeEach(() => {
    inc.mockReset();
  });

  it("increments the counter with the subsystem and operation labels", () => {
    recordRedisDegradation("seat", "read");

    expect(inc).toHaveBeenCalledWith({ subsystem: "seat", operation: "read" });
  });

  it("counts every occurrence — the RATE is the alarm, so it must not dedupe", () => {
    for (let i = 0; i < 5; i++) recordRedisDegradation("presence", "read");

    expect(inc).toHaveBeenCalledTimes(5);
  });

  it("swallows a throwing metrics backend instead of propagating", () => {
    inc.mockImplementation(() => {
      throw new Error("prom-client exploded");
    });

    expect(() => recordRedisDegradation("gift-buffer", "pending-count")).not.toThrow();
  });

  it("leaves a degrading call site's fallback value intact when metrics throw", () => {
    inc.mockImplementation(() => {
      throw new Error("prom-client exploded");
    });

    // The shape every instrumented site has: catch a Redis error, record the
    // degradation, return the fallback. Instrumentation failing must not turn
    // that into an unhandled rejection — that would make the monitoring the
    // outage.
    function readSeatsWithFallback(): string[] {
      try {
        throw new Error("READONLY You can't write against a read only replica");
      } catch {
        recordRedisDegradation("seat", "read");
        return [];
      }
    }

    expect(readSeatsWithFallback()).toEqual([]);
  });

  it("returns nothing — call sites must not be able to branch on it", () => {
    expect(recordRedisDegradation("user-room", "write")).toBeUndefined();
  });
});
