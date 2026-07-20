/**
 * Dependency-free, timer-free token bucket.
 *
 * Sentry event volume must be bounded client-side at ~20 burst / 30 per hour
 * per process, so a fleet-wide error storm cannot exhaust the org's monthly
 * error quota. Client-side dropping is deliberate — a server-side rate limit
 * would already have counted the events.
 *
 * No `setInterval`/timers: this runs inside a long-lived audio server
 * process, and a timer would keep the event loop alive. Refill is computed
 * lazily, from elapsed wall-clock time, on every `take()` call instead.
 */

export interface TokenBucket {
  /** Consume one token. Returns false when the bucket is empty (caller drops the event). */
  take(): boolean;
}

export function tokenBucket(opts: {
  capacity: number;
  refillPerHour: number;
}): TokenBucket {
  const capacity = Number.isFinite(opts.capacity) ? opts.capacity : 0;
  const refillPerHour = Number.isFinite(opts.refillPerHour)
    ? opts.refillPerHour
    : 0;
  const refillPerMs = refillPerHour > 0 ? refillPerHour / 3_600_000 : 0;

  let tokens = capacity > 0 ? capacity : 0;
  let lastRefillAt = Date.now();

  /** Lazily credits tokens for elapsed time. Never grants tokens for a clock that moved backwards. */
  function refill(): void {
    const now = Date.now();
    const elapsedMs = now - lastRefillAt;

    if (elapsedMs <= 0) {
      // Same tick, or the clock jumped backwards — resync the anchor so a
      // later forward jump measures from `now`, but credit nothing.
      lastRefillAt = now;
      return;
    }

    if (refillPerMs > 0) {
      tokens = Math.min(capacity, tokens + elapsedMs * refillPerMs);
    }
    lastRefillAt = now;
  }

  return {
    take(): boolean {
      try {
        if (capacity <= 0) return false;

        refill();

        if (tokens >= 1) {
          tokens -= 1;
          return true;
        }
        return false;
      } catch {
        // Telemetry plumbing must never throw into caller code.
        return false;
      }
    },
  };
}
