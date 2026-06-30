/**
 * RoomModeController — the pure decision core for the interactive↔broadcast flip
 * (realtime-08).
 *
 * No IO, no Redis, no sockets: feed it the current mode + Listener count and the
 * two thresholds, it returns the new mode, whether it changed, and the
 * promotion/demotion bookkeeping. Fully table-testable in isolation.
 *
 * ## Hysteresis (no flapping)
 *
 * A single threshold would flap a Room sitting on the boundary as Listeners
 * trickle in and out. Two thresholds with a gap between them fix this:
 *
 *   - interactive → broadcast  when  listenerCount >= upThreshold   (~1500)
 *   - broadcast → interactive  when  listenerCount <= downThreshold (~1000)
 *
 * Inside the band (downThreshold < count < upThreshold) the mode is **held** —
 * whatever it already is stays. `upThreshold > downThreshold` is required; the
 * width of the band is the flap-resistance.
 *
 * **At this slice the mode is plumbing + telemetry only** — both modes still use
 * WebRTC (no HLS). 09/10 attach real transport behaviour to the contract.
 */
import type { RoomMode } from "../types.js";

export interface ModeDecisionInput {
  /** The Room's current mode (source of truth: room:state.mode). */
  currentMode: RoomMode;
  /** Passive Listeners in the Room (the threshold input). */
  listenerCount: number;
  /**
   * realtime-17b: count of speakers actually emitting audio RTP right now
   * (resumed audio producers). Broadcast requires ≥1 to ENTER: promoting with no
   * speaker produces no HLS stream, so clients would 404 on master.m3u8 forever.
   * It does NOT force a demote once in broadcast (see demote logic) — that would
   * herd a huge Room back onto WebRTC every time the last speaker briefly leaves.
   */
  speakerCount: number;
  /** Flip up to broadcast at/above this count. Must be > downThreshold. */
  upThreshold: number;
  /** Flip back down to interactive at/below this count. */
  downThreshold: number;
}

/** Direction of a mode change, or null when the mode held. */
export type ModeTransition = "promote" | "demote" | null;

export interface ModeDecision {
  /** The mode the Room should be in after this evaluation. */
  mode: RoomMode;
  /** True iff `mode` differs from `currentMode`. */
  changed: boolean;
  /**
   * Promotion/demotion bookkeeping:
   *  - `promote` — interactive → broadcast (crossed up)
   *  - `demote`  — broadcast → interactive (crossed down)
   *  - `null`    — mode held (inside the hysteresis band, or already settled)
   */
  transition: ModeTransition;
}

export class RoomModeController {
  /** Pure: decide the Room's mode from its current mode + Listener count. */
  decide(input: ModeDecisionInput): ModeDecision {
    const { currentMode, listenerCount, speakerCount, upThreshold, downThreshold } =
      input;

    // realtime-17b: never promote without a speaker — a broadcast with no audio
    // source has no HLS stream, so listeners would 404 on master.m3u8 forever.
    if (
      currentMode === "interactive" &&
      listenerCount >= upThreshold &&
      speakerCount >= 1
    ) {
      return { mode: "broadcast", changed: true, transition: "promote" };
    }

    // Demote on the listener floor only (hysteresis). Deliberately NOT on
    // speakerCount===0: a broadcast Room is by definition large (≥ upThreshold
    // listeners), so demoting every time the last speaker briefly leaves would
    // flap thousands of Listeners back onto per-listener WebRTC — the exact SFU
    // herd the broadcast tier exists to avoid. While speakers are momentarily
    // gone the publisher simply stops emitting; clients ride the gap via hls.js
    // cold-start retry and pick up when a speaker returns.
    if (currentMode === "broadcast" && listenerCount <= downThreshold) {
      return { mode: "interactive", changed: true, transition: "demote" };
    }

    // Inside the band, or on the correct side already → hold.
    return { mode: currentMode, changed: false, transition: null };
  }
}
