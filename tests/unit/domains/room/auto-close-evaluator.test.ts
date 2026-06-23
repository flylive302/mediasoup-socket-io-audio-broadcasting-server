import { describe, it, expect } from "vitest";
import {
  AutoCloseEvaluator,
  type AutoCloseInput,
} from "@src/domains/room/auto-close/auto-close-evaluator.js";

const evaluator = new AutoCloseEvaluator();

// Base = a room that WOULD close (empty, interactive, activity expired, grace elapsed).
function input(overrides: Partial<AutoCloseInput> = {}): AutoCloseInput {
  return {
    interactivePresent: 0,
    speakerCount: 0,
    mode: "interactive",
    activityExpired: true,
    zeroSince: 0,
    now: 60_000,
    graceMs: 15_000,
    ...overrides,
  };
}

describe("AutoCloseEvaluator.shouldClose", () => {
  // Table-driven: external behavior only — (presence, speakers, mode, activity,
  // grace) → close/keep. Encodes the Q6 rule.
  const cases: Array<{ name: string; in: Partial<AutoCloseInput>; close: boolean }> = [
    // ── Presence keeps a room alive (the core "lone listener" fix) ──
    { name: "lone interactive listener keeps a small room alive", in: { interactivePresent: 1 }, close: false },
    { name: "many interactive present → keep", in: { interactivePresent: 42 }, close: false },
    { name: "truly empty + activity expired + grace elapsed → close", in: {}, close: true },

    // ── Broadcast mode: a Speaker keeps a host-present room alive ──
    { name: "broadcast with a Speaker but zero listeners → keep", in: { mode: "broadcast", interactivePresent: 0, speakerCount: 1 }, close: false },
    { name: "broadcast, no Speaker, no presence → close (host abandoned)", in: { mode: "broadcast", speakerCount: 0 }, close: true },
    { name: "interactive mode ignores speakerCount → close", in: { mode: "interactive", speakerCount: 5 }, close: true },

    // ── Activity window must have elapsed ──
    { name: "empty but activity NOT expired → keep", in: { activityExpired: false }, close: false },

    // ── Grace window: never close on a transient zero ──
    { name: "zeroSince null (not currently zero) → keep", in: { zeroSince: null }, close: false },
    { name: "zero observed this instant (grace not elapsed) → keep", in: { zeroSince: 60_000, now: 60_000 }, close: false },
    { name: "zero for less than grace → keep", in: { zeroSince: 50_000, now: 60_000, graceMs: 15_000 }, close: false },
    { name: "zero for exactly grace → close", in: { zeroSince: 45_000, now: 60_000, graceMs: 15_000 }, close: true },
    { name: "zero well past grace → close", in: { zeroSince: 0, now: 60_000, graceMs: 15_000 }, close: true },

    // ── Presence dominates every other signal ──
    { name: "present but activity expired + grace elapsed → keep", in: { interactivePresent: 1, zeroSince: null }, close: false },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(evaluator.shouldClose(input(c.in))).toBe(c.close);
    });
  }
});
