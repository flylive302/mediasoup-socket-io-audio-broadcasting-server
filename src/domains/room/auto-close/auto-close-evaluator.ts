/**
 * AutoCloseEvaluator — the pure decision core for room auto-close (realtime-01).
 *
 * No IO, no Redis, no sockets: feed it the facts, it returns close/keep. This
 * encodes the Q6 lifecycle rule and is fully table-testable in isolation.
 *
 * Rule: a Room is ALIVE while
 *     (interactive socket presence >= 1)  OR  (broadcast mode AND >= 1 Speaker)
 * It may be closed only when it is NOT alive AND the inactivity window has
 * elapsed AND real presence has been zero for at least the grace window (so a
 * transient zero between poll ticks — a reconnect in progress — never closes a
 * Room out from under a returning user).
 *
 * `mode`/`speakerCount` are inputs for forward-compatibility with the broadcast
 * tier (realtime-08/09); today the poller passes `interactive`/`0`.
 */

export type RoomMode = "interactive" | "broadcast";

export interface AutoCloseInput {
  /** Real Socket.IO presence in the owning region (`io.in(room).fetchSockets()`). */
  interactivePresent: number;
  /** Occupied Speaker seats — only consulted in broadcast mode. */
  speakerCount: number;
  mode: RoomMode;
  /** True when the `room:{id}:activity` key has expired (inactivity window elapsed). */
  activityExpired: boolean;
  /** Epoch ms when presence was first observed at zero, or null if not currently zero. */
  zeroSince: number | null;
  /** Current epoch ms. */
  now: number;
  /** Required duration presence must stay zero before closing. */
  graceMs: number;
}

export class AutoCloseEvaluator {
  /** Pure: returns true iff the Room should be auto-closed now. */
  shouldClose(input: AutoCloseInput): boolean {
    if (this.isAlive(input)) return false;
    if (!input.activityExpired) return false;
    if (input.zeroSince === null) return false;
    return input.now - input.zeroSince >= input.graceMs;
  }

  /** A Room is alive while it has interactive presence, or a Speaker in broadcast mode. */
  private isAlive(input: AutoCloseInput): boolean {
    if (input.interactivePresent >= 1) return true;
    return input.mode === "broadcast" && input.speakerCount >= 1;
  }
}
