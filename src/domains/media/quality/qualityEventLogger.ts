/**
 * observability-audio-quality 03 — the complaint path.
 *
 * When a user says "audio was bad in room X around 14:20", this is what an
 * engineer searches. Ticket 01 answers *how bad the fleet was* and cannot
 * answer *who*, because its cardinality rule forbids a room or user label —
 * a metric keyed by room is a series explosion that grows with the product.
 *
 * The resolution is that room-scoped detail goes to the LOG STREAM instead. A
 * log record is discrete: it creates no time series and costs no cardinality,
 * so `roomId` and `userId` are free here in exactly the way they are forbidden
 * one module over. ⛔ This module must therefore never touch a metric. The
 * cardinality test scrapes for these very identifiers.
 *
 * LEVEL-TRIGGERED, NOT EDGE-TRIGGERED. A leg is re-evaluated on every sampler
 * tick and emits whenever it is at or below the threshold, bounded by the
 * limiter below. Edge-triggering — emitting only on the transition — was
 * rejected twice over: a leg that registers already-bad never transitions and
 * would be silent forever, and a leg oscillating across the threshold emits
 * *more* than a level-triggered one. AC #1's "crosses the threshold" still
 * holds, because the first tick at or below it acquires immediately.
 *
 * ⛔ NOT the Redis `RateLimiter` from `infrastructure/`, deliberately. That one
 * is for user actions that must be limited consistently across the fleet; this
 * limits writes to THIS process's own log stream, so a shared window would be
 * wrong as well as a Redis round trip on a metrics path.
 */
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { QualityEvent } from "./qualityAggregator.js";

/**
 * How many idle intervals a key survives before pruning.
 *
 * ⚠️ PRUNING IS NOT TIDINESS. Keys are stream ids, which are unbounded over
 * the process's lifetime — every join creates new ones. Without this the map
 * is a slow leak on a long-lived instance, the same class of bug as ticket
 * 02's lingering closed handles. Age alone is the criterion: a leg that is
 * still degraded refreshes its own timestamp every time it emits, so it can
 * never be pruned out from under an active degradation.
 */
const PRUNE_AFTER_INTERVALS = 4;

/**
 * Per-leg emission window. Holds only a timestamp per key, so the whole
 * structure is a `Map<string, number>` and needs no clock of its own — every
 * method takes `now`, which is what makes it deterministic under fake timers.
 */
export class QualityEventLimiter {
  private readonly lastEmittedAt = new Map<string, number>();

  /** GATE — pure read. Does NOT consume the window; `record` does that. */
  isAllowed(key: string, now: number, minIntervalMs: number): boolean {
    const last = this.lastEmittedAt.get(key);
    return last === undefined || now - last >= minIntervalMs;
  }

  /** Consume the window. Called only for an event actually written. */
  record(key: string, now: number): void {
    this.lastEmittedAt.set(key, now);
  }

  /** Drop keys idle for `PRUNE_AFTER_INTERVALS` windows. */
  prune(now: number, minIntervalMs: number): void {
    const horizon = minIntervalMs * PRUNE_AFTER_INTERVALS;
    for (const [key, last] of this.lastEmittedAt) {
      if (now - last > horizon) this.lastEmittedAt.delete(key);
    }
  }

  get size(): number {
    return this.lastEmittedAt.size;
  }

  clear(): void {
    this.lastEmittedAt.clear();
  }
}

/** Process-wide limiter. One MSAB process serves many rooms. */
export const qualityEventLimiter = new QualityEventLimiter();

/**
 * Write this tick's degraded legs to the log stream.
 *
 * Returns the number of records written, which is what the tests assert
 * against — the alternative, asserting on a mocked logger, would not prove
 * the record's serialized shape, and the shape is the deliverable: a
 * CloudWatch query filtering `roomId` fails silently against a nested one.
 *
 * @param now injected so the rate limit is testable without wall-clock waits.
 */
export function logQualityEvents(
  events: readonly QualityEvent[],
  now: number = Date.now(),
): number {
  const minIntervalMs = config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS;
  const maxPerTick = config.AUDIO_QUALITY_EVENT_MAX_PER_TICK;

  let written = 0;
  let overCeiling = 0;

  // Worst first, so the ceiling below truncates the legs an engineer cares
  // least about. Copied — the aggregate is not ours to reorder.
  const worstFirst = [...events].sort((a, b) => a.score - b.score);

  for (const event of worstFirst) {
    if (!limiterAllows(event, now, minIntervalMs)) continue;

    if (written >= maxPerTick) {
      // Deliberately NOT recorded against the limiter: this leg was never
      // written, so it must stay eligible on the next tick rather than
      // silently burning its window.
      overCeiling++;
      continue;
    }

    qualityEventLimiter.record(event.streamId, now);
    write(event);
    written++;
  }

  if (overCeiling > 0) {
    // One line, not N. Its absence is what tells an engineer the list above is
    // complete; without it a truncated list reads as the whole incident.
    logger.warn(
      {
        suppressedLegs: overCeiling,
        writtenLegs: written,
        maxPerTick,
        event: "audio_quality_degraded_truncated",
      },
      "Audio quality events truncated — more degraded legs than the per-tick ceiling",
    );
  }

  qualityEventLimiter.prune(now, minIntervalMs);

  return written;
}

/** Reset between tests. Never called in production. */
export function resetQualityEventLimiter(): void {
  qualityEventLimiter.clear();
}

function limiterAllows(
  event: QualityEvent,
  now: number,
  minIntervalMs: number,
): boolean {
  return qualityEventLimiter.isAllowed(event.streamId, now, minIntervalMs);
}

/**
 * EXECUTE — one record.
 *
 * ⛔ EVERY SEARCHABLE FIELD IS TOP LEVEL AND FLAT. Nesting them under a
 * `quality: {…}` object would read identically in a terminal and break every
 * CloudWatch Insights filter written against `roomId`, silently returning zero
 * rows for a room that did report. There is a test asserting the parsed JSON's
 * own keys for exactly this reason.
 *
 * `warn`, not `error`: degraded audio for one participant is a condition to
 * investigate on request, not a fault the on-call should be paged for. The
 * paging signal is ticket 01's fleet percentile.
 */
function write(event: QualityEvent): void {
  logger.warn(
    {
      event: "audio_quality_degraded",
      roomId: event.roomId,
      userId: event.userId,
      streamId: event.streamId,
      direction: event.direction,
      score: event.score,
      threshold: event.threshold,
      // Present only when the sweep has seen this leg. Units are the SFU's
      // own: fractionLost is the raw RTCP 0-255 byte, jitter is RTP timestamp
      // ticks, roundTripTime is milliseconds.
      ...(event.fractionLost !== undefined && {
        fractionLost: event.fractionLost,
      }),
      ...(event.jitter !== undefined && { jitter: event.jitter }),
      ...(event.roundTripTime !== undefined && {
        roundTripTime: event.roundTripTime,
      }),
    },
    "Audio quality degraded",
  );
}
