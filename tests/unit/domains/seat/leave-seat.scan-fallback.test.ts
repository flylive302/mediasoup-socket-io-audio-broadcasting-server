import { describe, it, expect } from "vitest";
import {
  LEAVE_SEAT_SCRIPT,
  TAKE_SEAT_SCRIPT,
  ASSIGN_SEAT_SCRIPT,
} from "@src/domains/seat/seat.lua-scripts.js";

// F-41 (supersedes F-38): a user must occupy at most one seat. The per-user
// reverse index (`userSeatKey`) can expire or desync while the shared seats
// hash — re-EXPIRE'd by ANY user's take — still holds the user's entry. Relying
// on a single reverse-index lookup to clear the prior seat then left orphaned
// "ghost" entries, so the same user accumulated across seats (each reading as
// SEAT_TAKEN forever) and observers saw them duplicated. The fix makes every
// mutation scan the bounded seats hash and HDEL EVERY entry for the user,
// returning all vacated indices. These Lua scripts run end-to-end against Redis
// in the seat.repository tests; here we assert the structural invariants of the
// source so an accidental revert fails CI.

describe("Seat single-occupancy heal (F-41)", () => {
  describe("LEAVE_SEAT_SCRIPT", () => {
    it("always scans the bounded seats hash (no reverse-index fast path)", () => {
      expect(LEAVE_SEAT_SCRIPT).toContain("HGETALL");
      // The old `if not seatIndex then ... HGETALL` conditional fallback is gone.
      expect(LEAVE_SEAT_SCRIPT).not.toMatch(/if not seatIndex then/);
    });

    it("collects and HDELs every matching entry for the user", () => {
      expect(LEAVE_SEAT_SCRIPT).toMatch(/HGETALL[\s\S]*HDEL[\s\S]*table\.insert\(cleared/);
    });

    it("returns clearedSeatIndices and still returns NOT_SEATED when none found", () => {
      expect(LEAVE_SEAT_SCRIPT).toContain("clearedSeatIndices = cleared");
      expect(LEAVE_SEAT_SCRIPT).toContain('error = "NOT_SEATED"');
    });
  });

  describe("TAKE_SEAT_SCRIPT", () => {
    it("scans for and clears all of the user's other seats before taking", () => {
      expect(TAKE_SEAT_SCRIPT).toContain("HGETALL");
      expect(TAKE_SEAT_SCRIPT).toMatch(/HDEL[\s\S]*table\.insert\(cleared/);
      // Must not re-add the target seat to the cleared list.
      expect(TAKE_SEAT_SCRIPT).toContain("idx ~= tostring(seatIndex)");
    });

    it("no longer relies on GET userSeatKey to find the prior seat", () => {
      expect(TAKE_SEAT_SCRIPT).not.toMatch(/local previousSeatIndex = redis\.call\('GET'/);
      expect(TAKE_SEAT_SCRIPT).toContain("clearedSeatIndices = cleared");
    });
  });

  describe("ASSIGN_SEAT_SCRIPT", () => {
    it("displaces a DIFFERENT occupant and scan-clears the assigned user's other seats", () => {
      // Only clean the displaced user's reverse index when it's not the same user.
      expect(ASSIGN_SEAT_SCRIPT).toMatch(/tostring\(ddata\.userId\) ~= tostring\(userId\)/);
      expect(ASSIGN_SEAT_SCRIPT).toContain("HGETALL");
      expect(ASSIGN_SEAT_SCRIPT).toMatch(/HDEL[\s\S]*table\.insert\(cleared/);
      expect(ASSIGN_SEAT_SCRIPT).toContain("clearedSeatIndices = cleared");
    });
  });
});
