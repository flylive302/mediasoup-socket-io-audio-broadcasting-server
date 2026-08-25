import { describe, it, expect, vi } from "vitest";

let tickMs = 0;

vi.mock("@src/domains/gift/flags.js", () => ({
  giftRoomTickMs: () => tickMs,
}));

import { getServerCapabilities } from "@src/domains/gift/capabilities.js";

describe("getServerCapabilities (capability handshake)", () => {
  it("advertises giftBatch: false when GIFT_ROOM_TICK_MS is 0 (default, ships inert)", () => {
    tickMs = 0;
    expect(getServerCapabilities()).toEqual({ giftBatch: false });
  });

  it("advertises giftBatch: true when GIFT_ROOM_TICK_MS > 0", () => {
    tickMs = 100;
    expect(getServerCapabilities()).toEqual({ giftBatch: true });
  });

  it("reads the flag fresh on every call, not cached at import time", () => {
    tickMs = 0;
    expect(getServerCapabilities().giftBatch).toBe(false);
    tickMs = 250;
    expect(getServerCapabilities().giftBatch).toBe(true);
  });
});
