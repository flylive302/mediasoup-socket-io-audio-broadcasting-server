/**
 * aws-production/24 follow-up — periodic instance heartbeat.
 *
 * A fresh box must announce itself immediately and keep doing so on a timer;
 * a failing Laravel must never surface as a throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: { AWS_REGION: "ap-south-1" },
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  startInstanceHeartbeat,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
} from "@src/infrastructure/instance-heartbeat.js";
import { logger } from "@src/infrastructure/logger.js";

describe("startInstanceHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("beats immediately at boot, then every interval, with the configured region", async () => {
    const client = { sendInstanceHeartbeat: vi.fn().mockResolvedValue(true) };

    const handle = startInstanceHeartbeat(client, 1_000);

    expect(client.sendInstanceHeartbeat).toHaveBeenCalledTimes(1);
    expect(client.sendInstanceHeartbeat).toHaveBeenCalledWith("ap-south-1");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.sendInstanceHeartbeat).toHaveBeenCalledTimes(4);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.sendInstanceHeartbeat).toHaveBeenCalledTimes(4);
  });

  it("defaults to a 15s cadence (well under the resolver's freshness horizon)", () => {
    expect(INSTANCE_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });

  it("never throws when the client rejects — logs and keeps the timer alive", async () => {
    const client = {
      sendInstanceHeartbeat: vi.fn().mockRejectedValue(new Error("laravel down")),
    };

    const handle = startInstanceHeartbeat(client, 1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.sendInstanceHeartbeat).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalled();
    handle.stop();
  });
});
