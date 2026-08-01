/**
 * Rotation-overlap key matching.
 *
 * These tests guard a seam that only matters during a two-sided secret
 * rotation, so a regression here is invisible until the moment it costs an
 * outage. The fail-closed cases matter most: an empty or unconfigured key must
 * never authorise anything.
 */
import { describe, it, expect } from "vitest";
import {
  matchesRotatableKey,
  parsePreviousKeys,
} from "@src/shared/keyRotation.js";

const CURRENT = "a".repeat(64);
const PREVIOUS = "b".repeat(64);
const OTHER = "c".repeat(64);

describe("matchesRotatableKey", () => {
  it("accepts the current key when no previous keys are configured", () => {
    expect(matchesRotatableKey(CURRENT, CURRENT, [])).toBe(true);
  });

  it("rejects a wrong key when no previous keys are configured", () => {
    expect(matchesRotatableKey(OTHER, CURRENT, [])).toBe(false);
  });

  it("accepts either key mid-rotation", () => {
    expect(matchesRotatableKey(CURRENT, CURRENT, [PREVIOUS])).toBe(true);
    expect(matchesRotatableKey(PREVIOUS, CURRENT, [PREVIOUS])).toBe(true);
  });

  it("still rejects an unrelated key mid-rotation", () => {
    expect(matchesRotatableKey(OTHER, CURRENT, [PREVIOUS])).toBe(false);
  });

  it("stops accepting the old key once the overlap is removed", () => {
    // The final step of a rotation: unset *_PREVIOUS and the old key dies.
    expect(matchesRotatableKey(PREVIOUS, CURRENT, [])).toBe(false);
  });

  // ── Fail-closed cases ───────────────────────────────────────────────────
  // Each of these would be an auth bypass, not merely a bug.

  it("rejects an undefined presented key", () => {
    expect(matchesRotatableKey(undefined, CURRENT, [PREVIOUS])).toBe(false);
  });

  it("rejects an empty presented key", () => {
    expect(matchesRotatableKey("", CURRENT, [PREVIOUS])).toBe(false);
  });

  it("rejects everything when no key is configured at all", () => {
    expect(matchesRotatableKey(CURRENT, undefined, [])).toBe(false);
    expect(matchesRotatableKey("", undefined, [])).toBe(false);
    expect(matchesRotatableKey("", "", [])).toBe(false);
  });

  it("never treats an empty configured value as an accepted key", () => {
    // An empty entry in the accepted list would authorise an empty header.
    expect(matchesRotatableKey("", "", [""])).toBe(false);
  });

  it("does not match on a prefix or substring", () => {
    expect(matchesRotatableKey("a".repeat(63), CURRENT, [])).toBe(false);
    expect(matchesRotatableKey("a".repeat(65), CURRENT, [])).toBe(false);
  });

  it("supports more than one overlap key", () => {
    const third = "d".repeat(64);
    expect(matchesRotatableKey(third, CURRENT, [PREVIOUS, third])).toBe(true);
  });
});

describe("parsePreviousKeys", () => {
  it("returns an empty list when unset or empty", () => {
    expect(parsePreviousKeys(undefined)).toEqual([]);
    expect(parsePreviousKeys("")).toEqual([]);
  });

  it("parses a single key", () => {
    expect(parsePreviousKeys(PREVIOUS)).toEqual([PREVIOUS]);
  });

  it("parses and trims a comma-separated list", () => {
    expect(parsePreviousKeys(` ${PREVIOUS} , ${OTHER} `)).toEqual([
      PREVIOUS,
      OTHER,
    ]);
  });

  it("drops blank entries from trailing or doubled commas", () => {
    expect(parsePreviousKeys(`${PREVIOUS},,`)).toEqual([PREVIOUS]);
    expect(parsePreviousKeys(",,")).toEqual([]);
  });
});
