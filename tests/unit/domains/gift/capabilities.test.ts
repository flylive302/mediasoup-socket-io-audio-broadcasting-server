import { describe, it, expect, vi } from "vitest";

let tickMs = 0;
let authority: "off" | "shadow" | "redis" = "off";

vi.mock("@src/domains/gift/flags.js", () => ({
  giftRoomTickMs: () => tickMs,
  giftBalanceAuthority: () => authority,
}));

import { getServerCapabilities } from "@src/domains/gift/capabilities.js";

describe("getServerCapabilities (capability handshake)", () => {
  it("advertises giftBatch: false when GIFT_ROOM_TICK_MS is 0 (default, ships inert)", () => {
    tickMs = 0;
    expect(getServerCapabilities()).toEqual({ giftBatch: false, ackBalance: false });
  });

  it("advertises giftBatch: true when GIFT_ROOM_TICK_MS > 0", () => {
    tickMs = 100;
    expect(getServerCapabilities()).toEqual({ giftBatch: true, ackBalance: false });
  });

  it("reads the flag fresh on every call, not cached at import time", () => {
    tickMs = 0;
    expect(getServerCapabilities().giftBatch).toBe(false);
    tickMs = 250;
    expect(getServerCapabilities().giftBatch).toBe(true);
  });

  // gift-authority-tick-fanout 12
  it("advertises ackBalance ONLY in redis mode (off and shadow keep today's client behaviour)", () => {
    authority = "off";
    expect(getServerCapabilities().ackBalance).toBe(false);
    authority = "shadow";
    expect(getServerCapabilities().ackBalance).toBe(false);
    authority = "redis";
    expect(getServerCapabilities().ackBalance).toBe(true);
    authority = "off";
  });
});
