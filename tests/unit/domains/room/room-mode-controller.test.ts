import { describe, it, expect } from "vitest";
import {
  RoomModeController,
  type ModeDecisionInput,
  type ModeDecision,
} from "@src/domains/room/mode/room-mode-controller.js";

const controller = new RoomModeController();

// Base = an interactive Room with the production-default thresholds.
function input(overrides: Partial<ModeDecisionInput> = {}): ModeDecisionInput {
  return {
    currentMode: "interactive",
    listenerCount: 0,
    // realtime-17b: default to a broadcastable Room (≥1 speaker) so the existing
    // threshold/hysteresis cases isolate the listener-count behaviour. The
    // speaker-gate gets its own dedicated cases below.
    speakerCount: 1,
    upThreshold: 1500,
    downThreshold: 1000,
    ...overrides,
  };
}

describe("RoomModeController.decide", () => {
  // Table-driven: (currentMode, listenerCount) → resulting decision. The crux
  // (AC5) is the hysteresis band holding in BOTH directions — a one-directional
  // table passes while flapping.
  const cases: Array<{
    name: string;
    in: Partial<ModeDecisionInput>;
    out: ModeDecision;
  }> = [
    // ── Promote up across the upper threshold ──
    {
      name: "interactive below up-threshold → hold interactive",
      in: { currentMode: "interactive", listenerCount: 1499 },
      out: { mode: "interactive", changed: false, transition: null },
    },
    {
      name: "interactive exactly at up-threshold → promote",
      in: { currentMode: "interactive", listenerCount: 1500 },
      out: { mode: "broadcast", changed: true, transition: "promote" },
    },
    {
      name: "interactive well above up-threshold → promote",
      in: { currentMode: "interactive", listenerCount: 30_000 },
      out: { mode: "broadcast", changed: true, transition: "promote" },
    },

    // ── Demote down across the lower threshold ──
    {
      name: "broadcast above down-threshold → hold broadcast",
      in: { currentMode: "broadcast", listenerCount: 1001 },
      out: { mode: "broadcast", changed: false, transition: null },
    },
    {
      name: "broadcast exactly at down-threshold → demote",
      in: { currentMode: "broadcast", listenerCount: 1000 },
      out: { mode: "interactive", changed: true, transition: "demote" },
    },
    {
      name: "broadcast empty → demote",
      in: { currentMode: "broadcast", listenerCount: 0 },
      out: { mode: "interactive", changed: true, transition: "demote" },
    },

    // ── Hysteresis band holds in BOTH directions (no flapping) ──
    // Same count (1200, mid-band) must keep whichever mode it is already in.
    {
      name: "mid-band stays interactive (rising, not yet at up)",
      in: { currentMode: "interactive", listenerCount: 1200 },
      out: { mode: "interactive", changed: false, transition: null },
    },
    {
      name: "mid-band stays broadcast (falling, not yet at down)",
      in: { currentMode: "broadcast", listenerCount: 1200 },
      out: { mode: "broadcast", changed: false, transition: null },
    },
    // Just inside each edge of the band: interactive holds at down+1, broadcast
    // holds at up-1 — the two-sided proof the band can't oscillate.
    {
      name: "interactive at down-threshold (1000) holds (no demote when already interactive)",
      in: { currentMode: "interactive", listenerCount: 1000 },
      out: { mode: "interactive", changed: false, transition: null },
    },
    {
      name: "broadcast at up-threshold (1500) holds (no re-promote when already broadcast)",
      in: { currentMode: "broadcast", listenerCount: 1500 },
      out: { mode: "broadcast", changed: false, transition: null },
    },
    {
      name: "interactive just below up holds",
      in: { currentMode: "interactive", listenerCount: 1499 },
      out: { mode: "interactive", changed: false, transition: null },
    },
    {
      name: "broadcast just above down holds",
      in: { currentMode: "broadcast", listenerCount: 1001 },
      out: { mode: "broadcast", changed: false, transition: null },
    },

    // ── realtime-17b: speaker-gate ──
    {
      name: "interactive over up-threshold but ZERO speakers → hold (no dead HLS)",
      in: { currentMode: "interactive", listenerCount: 30_000, speakerCount: 0 },
      out: { mode: "interactive", changed: false, transition: null },
    },
    {
      name: "interactive over up-threshold WITH a speaker → promote",
      in: { currentMode: "interactive", listenerCount: 1500, speakerCount: 1 },
      out: { mode: "broadcast", changed: true, transition: "promote" },
    },
    {
      name: "broadcast above down-threshold but last speaker left → HOLD (no WebRTC herd; client rides the gap)",
      in: { currentMode: "broadcast", listenerCount: 5000, speakerCount: 0 },
      out: { mode: "broadcast", changed: false, transition: null },
    },
    {
      name: "broadcast above down-threshold with a speaker → hold",
      in: { currentMode: "broadcast", listenerCount: 5000, speakerCount: 2 },
      out: { mode: "broadcast", changed: false, transition: null },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(controller.decide(input(c.in))).toEqual(c.out);
    });
  }

  it("respects custom thresholds", () => {
    expect(
      controller.decide({
        currentMode: "interactive",
        listenerCount: 50,
        speakerCount: 1,
        upThreshold: 50,
        downThreshold: 25,
      }),
    ).toEqual({ mode: "broadcast", changed: true, transition: "promote" });
  });
});
