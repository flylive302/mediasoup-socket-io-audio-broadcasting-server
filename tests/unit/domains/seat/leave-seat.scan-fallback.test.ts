import { describe, it, expect } from "vitest";
import { LEAVE_SEAT_SCRIPT } from "@src/domains/seat/seat.lua-scripts.js";

// F-38: TTL skew can expire the per-user reverse index (`userSeatKey`) while
// the shared seats hash — refreshed by ANY user's take — still holds this
// user's entry. The old LEAVE_SEAT script returned NOT_SEATED, orphaning the
// seat permanently. The fix adds a bounded HGETALL scan fallback so the orphan
// is releasable by `seat:leave` and by the seat-grace sweeper. This script is
// exercised end-to-end against Redis in seat.repository tests; here we assert
// the structural invariants of the Lua source so an accidental revert would
// fail CI.

describe("LEAVE_SEAT_SCRIPT (F-38 scan fallback)", () => {
  it("falls back to an HGETALL scan when the reverse index is missing", () => {
    expect(LEAVE_SEAT_SCRIPT).toContain("HGETALL");
    expect(LEAVE_SEAT_SCRIPT).toMatch(/if not seatIndex then[\s\S]*HGETALL/);
  });

  it("HDELs the orphan seat and DELs the (now-set) reverse index in the fallback path", () => {
    // Strip line breaks for a fuzzy ordering check inside the fallback branch.
    const fallback = LEAVE_SEAT_SCRIPT.match(
      /if not seatIndex then([\s\S]*?)return cjson\.encode\(\{success = false/,
    )?.[1] ?? "";
    expect(fallback).toContain("HDEL");
    expect(fallback).toContain("DEL");
    expect(fallback).toContain("seatIndex = tonumber(idx)");
  });

  it("still returns NOT_SEATED when neither the index nor the scan finds the user", () => {
    expect(LEAVE_SEAT_SCRIPT).toContain('error = "NOT_SEATED"');
  });
});
