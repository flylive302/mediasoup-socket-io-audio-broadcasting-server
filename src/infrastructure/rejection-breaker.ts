/**
 * Unhandled-rejection circuit breaker (aws-production/35).
 *
 * Counter-based: tolerate transient rejections, crash only when they are
 * systemic (>= threshold within the sliding window). Extracted from index.ts
 * so the classification below is unit-testable at a module seam.
 */

export interface RejectionBreakerOptions {
  threshold: number;
  windowMs: number;
}

export type RejectionAction = "crash" | "count" | "redis-transient";

export interface RejectionVerdict {
  action: RejectionAction;
  /** Rejections currently inside the sliding window (after this record). */
  count: number;
}

export interface RejectionBreaker {
  record(err: unknown, now: number): RejectionVerdict;
}

export function createRejectionBreaker(opts: RejectionBreakerOptions): RejectionBreaker {
  const timestamps: number[] = [];

  return {
    record(err: unknown, now: number): RejectionVerdict {
      if (isTransientRedisRejection(err)) {
        return { action: "redis-transient", count: timestamps.length };
      }

      timestamps.push(now);
      while (timestamps.length > 0 && timestamps[0]! < now - opts.windowMs) {
        timestamps.shift();
      }

      if (timestamps.length >= opts.threshold) {
        return { action: "crash", count: timestamps.length };
      }
      return { action: "count", count: timestamps.length };
    },
  };
}

/**
 * ElastiCache failover produces a burst of these from fire-and-forget call
 * sites (observed 2026-08-15: 2 of 4 staging failovers crash-exited MSAB via
 * the threshold). They are a known, self-healing degradation — ioredis
 * reconnects and the app already treats each failure as a visible error — so
 * they must not count toward the crash threshold. Anything not matched here
 * still counts: the safety valve for genuinely unknown rejection storms stays.
 *
 * Matched by exact ioredis shapes (verified against ioredis 5 source):
 * - Command.js: `new Error("Command timed out")` (commandTimeout wrapper)
 * - utils: CONNECTION_CLOSED_ERROR_MSG = "Connection is closed."
 * - MaxRetriesPerRequestError (name), thrown when maxRetriesPerRequest trips
 */
export function isTransientRedisRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "MaxRetriesPerRequestError") return true;
  return err.message === "Command timed out" || err.message === "Connection is closed.";
}
