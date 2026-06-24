/**
 * StatusCoalescer — collapse MSAB→Laravel Room status churn (realtime-02).
 *
 * Every membership change (join / leave / kick) previously fired its own
 * fire-and-forget `updateRoomStatus`. Under churn that (a) flooded the shared
 * internal rate limiter → 429-dropped status updates, and (b) was wasteful — only
 * the FINAL state in a burst matters. This buffers the latest status per Room and
 * flushes on a trailing-edge timer, so at most one update per Room per window
 * reaches Laravel.
 *
 * State transitions that must not be delayed use `flushNow` (Room close), which
 * also CANCELS any buffered participant update for that Room so a stale
 * `is_live:true` can never land after — and resurrect — a closed Room.
 *
 * The Laravel side applies updates idempotently (absolute is_live/count set), so
 * a coalesced or duplicated delivery is safe.
 */
import { config } from "@src/config/index.js";
import type { Logger } from "pino";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { RoomStatusUpdate } from "@src/integrations/types.js";

export class StatusCoalescer {
  /** roomId → latest pending status update (last write wins within a window). */
  private readonly pending = new Map<string, RoomStatusUpdate>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly laravelClient: LaravelClient,
    private readonly logger: Logger,
    private readonly windowMs: number = config.ROOM_STATUS_COALESCE_WINDOW_MS,
  ) {}

  /** Start the trailing-edge flush timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flushAll(), this.windowMs);
    // Never keep the event loop (or tests) alive solely for the flush timer.
    this.timer.unref?.();
    this.logger.info({ windowMs: this.windowMs }, "Status coalescer started");
  }

  /**
   * Buffer the latest status for a Room. At most one update per Room per window
   * reaches Laravel; a newer submit within the window overwrites the older.
   */
  submit(roomId: string, status: RoomStatusUpdate): void {
    this.pending.set(roomId, status);
  }

  /**
   * Send a Room's status immediately, dropping any buffered entry for it first.
   * Used for transitions that must not wait for the window (Room close) — the
   * drop also cancels a stale buffered participant update so it can't resurrect
   * a closed Room on the next window tick.
   */
  async flushNow(roomId: string, status: RoomStatusUpdate): Promise<void> {
    this.pending.delete(roomId);
    await this.send(roomId, status);
  }

  /** Drop any buffered entry for a Room without sending (close-cleanup belt). */
  forget(roomId: string): void {
    this.pending.delete(roomId);
  }

  /** Flush every buffered Room (trailing-edge timer tick). */
  private async flushAll(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    await Promise.all(
      batch.map(([roomId, status]) => this.send(roomId, status)),
    );
  }

  private async send(roomId: string, status: RoomStatusUpdate): Promise<void> {
    try {
      await this.laravelClient.updateRoomStatus(roomId, status);
    } catch (err) {
      // REACT: a status flush is fire-and-forget — never throw from here.
      this.logger.error({ err, roomId }, "Coalesced room status flush failed");
    }
  }

  /** Flush anything pending + stop the timer (graceful shutdown). */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flushAll();
    this.logger.info("Status coalescer stopped");
  }
}
