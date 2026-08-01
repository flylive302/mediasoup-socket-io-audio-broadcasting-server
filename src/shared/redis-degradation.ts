/**
 * Redis degradation counter (platform-security 07).
 *
 * MSAB deliberately degrades rather than fails when Redis errors: a seat read
 * returns empty, a presence lookup returns zero, an auto-close check assumes
 * "still active". That is the right trade-off — failing closed would take
 * every live room down over a blip — but it means a broken subsystem looks
 * exactly like a healthy one from the outside. Roughly 20 sites across ~15
 * files degrade this way; most logged it and emitted no metric, so a sustained
 * outage was discoverable only by log archaeology. One (the gift buffer's
 * pending count) was fully silent.
 *
 * This helper is the ONE way those sites report. It is deliberately tiny and
 * does exactly one thing:
 *
 * - **It records a metric. It does NOT log.** Nearly every call site already
 *   has a log line that Grafana/CloudWatch alerts key on, and perturbing those
 *   would break existing alerting. Adding this is a one-line insertion next to
 *   the existing log, which cannot change it. The handful of genuinely silent
 *   sites add their own log line explicitly.
 * - **It never throws.** The whole point of these call sites is that they are
 *   already handling a failure and must still return their fallback value.
 *   Instrumentation that could throw would convert a graceful degradation into
 *   an unhandled rejection — turning the monitoring into the outage. Same
 *   nested-guard discipline the room-block mirror uses (`room-block.repository.ts`).
 * - **It does not change behaviour.** Callers ignore the return; there isn't
 *   one. Every instrumented site returns exactly what it returned before.
 *
 * Not to be used for the three paths that already have dedicated counters —
 * the JWT revocation gate, the room-block mirror, and the rate limiter.
 */
import { metrics } from "@src/infrastructure/metrics.js";

/**
 * Record that a Redis operation failed and the caller fell back to a default.
 *
 * @param subsystem Which area degraded — `"seat"`, `"presence"`, `"gift-buffer"`,
 *                  `"user-room"`, `"auto-close"`, … A code-controlled literal.
 * @param operation Which operation failed — `"read"`, `"write"`, `"delete"`,
 *                  `"pending-count"`, … Also a code-controlled literal.
 *
 * ⚠️ Both labels become Prometheus label values. **Never interpolate a room id,
 * user id, key name or any other unbounded value into either** — that is a
 * cardinality explosion, not an observability win. Put those in the log line.
 */
export function recordRedisDegradation(
  subsystem: string,
  operation: string,
): void {
  try {
    metrics.redisDegradations.inc({ subsystem, operation });
  } catch {
    // Intentionally empty — see the doc block above. A metrics backend that
    // throws must not be able to change what the degradation path returns.
  }
}
