/**
 * Shared "have I reported this already?" window for Sentry captures.
 *
 * This exists to protect the TOKEN BUDGET, not to tidy the issue stream.
 * The token bucket (token-bucket.ts) allows ~30 events/hour/process. Two
 * classes of capture are driven by things outside our control and would
 * otherwise drain that budget in seconds, starving the crash reports the
 * bucket exists to protect:
 *
 *   1. REACT failures — one failing dependency retried in a loop.
 *   2. GATE rejections — a frontend build sending a malformed payload on
 *      every keystroke. These are client-driven and completely unbounded.
 *
 * Callers MUST consult this BEFORE the event reaches `beforeSend`, because
 * that is where the token is actually spent. A duplicate suppressed here
 * costs nothing; a duplicate suppressed later costs a token.
 */

/**
 * One event per key per minute. Long enough that a tight loop collapses to a
 * single event; short enough that a genuinely recurring failure keeps proving
 * it is still happening.
 */
const DEDUPE_WINDOW_MS = 60_000;

/**
 * Hard ceiling on the map. This process runs for weeks, so an unbounded Map
 * keyed partly by error text is a slow memory leak. On overflow the whole map
 * is dropped rather than LRU-evicted: the cost of being wrong is one extra
 * duplicate event, and that is cheaper than maintaining eviction order on a
 * hot path.
 */
const DEDUPE_MAX_KEYS = 500;

const lastSeenAt = new Map<string, number>();

/**
 * Returns true if `key` was already seen inside the current window (i.e. the
 * caller should NOT capture). Returns false and arms the window otherwise.
 */
export function seenRecently(key: string): boolean {
  // Bound the key: it is built from error text at some call sites, and an
  // unbounded string would be both a memory and a hashing cost.
  const bounded = key.slice(0, 300);
  const now = Date.now();
  const previous = lastSeenAt.get(bounded);

  if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) {
    return true;
  }

  if (lastSeenAt.size >= DEDUPE_MAX_KEYS) {
    lastSeenAt.clear();
  }
  lastSeenAt.set(bounded, now);
  return false;
}

/** Test-only: clears the window between cases. */
export function __resetDedupe(): void {
  lastSeenAt.clear();
}
