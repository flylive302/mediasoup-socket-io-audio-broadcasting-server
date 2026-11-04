/**
 * gift-cashback-latency 01 (D0): tap → sender-sees-lucky-result latency.
 *
 * Observes `flylive_gift_lucky_result_latency_seconds{path}` at the moment MSAB
 * emits a `lucky:result` to the SENDER. The clock start is the payload's
 * `tapped_at` (epoch ms): the earliest tap's accept time in the burst, minted
 * by MSAB's own gift gate (`timestamp: Date.now()` in giftHandler.ts), carried
 * through Laravel unchanged and echoed back on the result payload.
 *
 * ── Clock note ──────────────────────────────────────────────────────────
 * Both ends of the subtraction are MSAB's `Date.now()`, never a Laravel
 * timestamp. `path="inline"` emits from the same flush that POSTed the batch,
 * but the gate that stamped the tap may have run on another instance, and a
 * `path="queued"` emit runs on whichever instance won the fan-out claim — so
 * cross-box NTP skew (milliseconds) applies to both. A negative delta (the
 * stamping box ran ahead) is skipped, not clamped to 0.
 *
 * REACT only: this never gates or alters delivery, and never throws.
 */
import { metrics } from "@src/infrastructure/metrics.js";
import { logger } from "@src/infrastructure/logger.js";

/** `inline` = batch-response `lucky[]` entry · `queued` = Laravel relay via event-router. */
/** 2001-09-09 in epoch ms; anything smaller is seconds or garbage. */
const MIN_EPOCH_MS = 1e12;

export type LuckyResultPath = "inline" | "queued";

/**
 * GATE (pure): seconds between the payload's `tapped_at` and `nowMs`, or null
 * when there is nothing trustworthy to observe — field absent / non-numeric /
 * non-finite / not epoch-ms (< 1e12) / dated after `nowMs`.
 */
export function luckyTapToEmitSeconds(payload: unknown, nowMs: number): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const tappedAt = (payload as { tapped_at?: unknown }).tapped_at;
  // Below 1e12 is not an epoch-MILLISECONDS stamp (0, negative, or epoch
  // seconds from a stray caller) — it would land in +Inf and skew the sum.
  if (typeof tappedAt !== "number" || !Number.isFinite(tappedAt) || tappedAt < MIN_EPOCH_MS) return null;
  const deltaMs = nowMs - tappedAt;
  if (deltaMs < 0) return null;
  return deltaMs / 1000;
}

/**
 * REACT: call right after the `lucky:result` emit to the sender. Absent or
 * future-dated `tapped_at` → no observation. Swallows every error so a metrics
 * fault can never reach the emit path.
 */
export function observeLuckyResultLatency(
  path: LuckyResultPath,
  payload: unknown,
  nowMs: number = Date.now(),
): void {
  try {
    const seconds = luckyTapToEmitSeconds(payload, nowMs);
    if (seconds === null) return;
    metrics.giftLuckyResultLatencySeconds.observe({ path }, seconds);
  } catch (error) {
    logger.debug({ error, path }, "Failed to observe lucky result latency — ignored");
  }
}
