/**
 * gift-authority-tick-fanout 01: a small bucketed counter for per-socket
 * burst-intensity metrics (giftsLast60s, inboundMsgsPerSec).
 *
 * Bucketed into 1-second slots, capped at `maxSlots` (default 60) so memory
 * per socket is bounded regardless of how long the socket lives or how many
 * events it sees — one slot is dropped (or reused) per second, never
 * accumulated. Pure counting logic, no timers of its own: callers pass in
 * `now` (Date.now()) so this is trivially unit-testable without fake timers.
 */
export class RollingWindow {
  /** timestamp (seconds, floored) → count, oldest first by insertion order */
  private readonly buckets = new Map<number, number>();

  constructor(private readonly maxSlots = 60) {}

  /** Record one event at `now` (ms since epoch). */
  record(now: number): void {
    const slot = Math.floor(now / 1000);
    this.buckets.set(slot, (this.buckets.get(slot) ?? 0) + 1);
    this.evictOld(slot);
  }

  /**
   * Count events in the trailing `windowMs` up to and including `now`.
   * Does not mutate beyond the same eviction `record()` already performs —
   * safe to call as often as needed (e.g. on every disconnect log).
   */
  countLast(windowMs: number, now: number): number {
    const nowSlot = Math.floor(now / 1000);
    const windowSlots = Math.ceil(windowMs / 1000);
    const cutoff = nowSlot - windowSlots + 1;
    let total = 0;
    for (const [slot, count] of this.buckets) {
      if (slot >= cutoff && slot <= nowSlot) {
        total += count;
      }
    }
    return total;
  }

  /**
   * Drop slots older than `maxSlots` seconds behind `latestSlot`. Bounds
   * memory at `maxSlots` entries regardless of event volume or socket
   * lifetime — a quiet socket's old buckets never linger, since eviction
   * is anchored to the newest recorded slot, not wall-clock polling.
   */
  private evictOld(latestSlot: number): void {
    const cutoff = latestSlot - this.maxSlots + 1;
    for (const slot of this.buckets.keys()) {
      if (slot < cutoff) {
        this.buckets.delete(slot);
      }
    }
  }
}
