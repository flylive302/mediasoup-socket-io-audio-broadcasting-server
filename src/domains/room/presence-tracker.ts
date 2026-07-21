/**
 * PresenceTracker — authoritative "who is actually in a Room" (realtime-01).
 *
 * Source of truth is real Socket.IO membership (`io.in(room).fetchSockets()`),
 * which the Redis adapter aggregates across every instance in the region. This
 * supersedes the drift-prone `room:state.participantCount` integer (Cause B):
 * the integer is demoted to advisory/telemetry and is periodically reconciled
 * back to this true count.
 *
 * Also owns the short grace window used by `AutoCloseEvaluator`: it remembers
 * when a Room was first observed empty so a transient zero is not mistaken for a
 * truly-empty Room.
 *
 * NOTE (scope): `fetchSockets()` is region-local. While the cross-region cascade
 * is still enabled (realtime-00 not yet run), a Room whose only Listeners are in
 * another region reads as empty here — no worse than the integer, which never
 * counted cross-region either. Cross-region presence aggregation is deliberately
 * deferred to post-cascade-removal (realtime-00/11); the evaluator already takes
 * presence as an injected input, so the aggregate plugs in later.
 */
import type { Server } from "socket.io";
import type { RoomStateRepository } from "./roomState.js";
import { fetchSocketsSafe } from "@src/shared/fetch-sockets-safe.js";
import { logger } from "@src/infrastructure/logger.js";

export class PresenceTracker {
  /** roomId → epoch ms when presence was first observed at zero. */
  private readonly zeroSince = new Map<string, number>();

  constructor(
    private readonly io: Server,
    private readonly state: RoomStateRepository,
  ) {}

  /** Real region-wide socket presence for a Room. */
  async present(roomId: string): Promise<number> {
    const sockets = await fetchSocketsSafe(this.io, roomId, logger);
    return sockets.length;
  }

  async isEmpty(roomId: string): Promise<boolean> {
    return (await this.present(roomId)) === 0;
  }

  /**
   * Record an observation of a Room's presence to drive the grace window.
   * Any non-empty observation clears the zero timer; the first empty
   * observation starts it.
   */
  observe(roomId: string, present: number, now: number): void {
    if (present > 0) {
      this.zeroSince.delete(roomId);
      return;
    }
    if (!this.zeroSince.has(roomId)) {
      this.zeroSince.set(roomId, now);
    }
  }

  /** Epoch ms when the Room was first observed empty, or null if not currently zero. */
  getZeroSince(roomId: string): number | null {
    return this.zeroSince.get(roomId) ?? null;
  }

  /** Drop grace bookkeeping for a Room (call on close so the map can't leak). */
  forget(roomId: string): void {
    this.zeroSince.delete(roomId);
  }

  /**
   * Heal the advisory integer + refresh the room:state TTL to the real presence
   * count. Update-if-exists only (the Lua returns null for a missing key) so it
   * can never resurrect a closed Room. Returns the authoritative count.
   */
  async reconcile(roomId: string): Promise<number> {
    const present = await this.present(roomId);
    await this.state.reconcileParticipantCount(roomId, present);
    // Feed the grace timer from every reconcile (heartbeat reconciles each owned
    // Room ~30s; finalizeLeave reconciles on every leave). This keeps `zeroSince`
    // tracking the TRUE last-empty time and clears it the instant a Room
    // repopulates — without it a stale zeroSince from an earlier emptiness would
    // let a later transient zero bypass the grace and eject a reconnecting user.
    this.observe(roomId, present, Date.now());
    return present;
  }
}
