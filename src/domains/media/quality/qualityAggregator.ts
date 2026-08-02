/**
 * Audio-quality aggregation — PURE.
 *
 * Snapshots in, `{ distributions, events }` out. No I/O, no timers, no
 * registry writes, no logger, no clock. This is the epic's primary test seam
 * (observability-audio-quality 01); everything that touches the outside world
 * lives in scoreObservers / qualityPublisher / qualitySampler.
 *
 * THE CARDINALITY RULE — the reason ticket 01 is graded `critical`:
 * no published time series may be keyed by a room, a user, a consumer or a
 * producer. `QualitySample` deliberately carries `roomId` / `userId` /
 * `streamId` because ticket 03 needs them on the *log* path, but they may
 * only ever reach `events`. They must NEVER reach `distributions`, whose
 * shape is the contract the publisher turns into Prometheus labels.
 */

/**
 * The participant's direction. Client legs only:
 *  - `sending`   — what a participant's microphone or music stream publishes
 *  - `receiving` — what a participant is served
 *
 * This is NOT all-producers-versus-all-consumers. Cross-instance pipe legs,
 * same-instance `pipeToRouter` legs and the HLS/FFmpeg egress mix are neither
 * and are out of scope — they never enter the registry in the first place.
 */
export type QualityDirection = "sending" | "receiving";

export const QUALITY_DIRECTIONS: readonly QualityDirection[] = [
  "sending",
  "receiving",
];

/**
 * The fixed set of statistic names. AC #4 permits exactly four label
 * dimensions — region, instance, direction and statistic — and this is the
 * closed enumeration behind the last one.
 *
 * The SFU's score runs 0–10 with 10 best, so the interesting tail is the LOW
 * end: `p01` and `p10` are the ones that answer "is anybody having a bad
 * time right now?". `p50` is the fleet's typical listener.
 */
export const QUALITY_STATISTICS = [
  "min",
  "p01",
  "p10",
  "p50",
  "p90",
  "max",
] as const;

export type QualityStatistic = (typeof QUALITY_STATISTICS)[number];

/** One live client leg's most recent score push. */
export interface QualitySample {
  /** Consumer or producer id. In-memory key only — NEVER a metric label. */
  readonly streamId: string;
  readonly direction: QualityDirection;
  /** The SFU's own 0–10 quality score. */
  readonly score: number;
  /** Ticket 03's log path only — NEVER a metric label. */
  readonly roomId: string;
  /** Ticket 03's log path only — NEVER a metric label. */
  readonly userId: string;
}

/**
 * One direction's distribution. Carries no room, user or stream identity —
 * this object is what the publisher is allowed to turn into labels.
 */
export interface QualityDistribution {
  readonly direction: QualityDirection;
  readonly sampleCount: number;
  readonly statistics: Readonly<Record<QualityStatistic, number>>;
}

/**
 * A single degraded client leg, ready for ticket 03 to write to the log
 * stream. Discrete, so it creates no time series and costs no cardinality.
 * Nothing consumes this yet.
 */
export interface QualityEvent {
  readonly roomId: string;
  readonly userId: string;
  readonly direction: QualityDirection;
  readonly score: number;
  readonly threshold: number;
}

export interface QualityAggregate {
  readonly distributions: readonly QualityDistribution[];
  readonly events: readonly QualityEvent[];
}

export interface AggregateQualityOptions {
  /** A leg at or below this score is degraded. Ticket 03 moves it to config. */
  readonly degradedAtOrBelow?: number;
}

/**
 * Default degraded threshold. mediasoup scores 0–10; sustained values at or
 * below 5 are the range where a listener actually notices. Ticket 03 replaces
 * this constant with a documented config key.
 */
export const DEFAULT_DEGRADED_SCORE = 5;

/**
 * Aggregate a snapshot of live client legs.
 *
 * Directions with zero samples are omitted entirely rather than reported as
 * zero — a score of 0 is *worst possible quality*, so emitting one for "no
 * traffic" would be a lie the alerting layer cannot distinguish from an
 * outage. The publisher resets stale label sets instead.
 */
export function aggregateQuality(
  samples: readonly QualitySample[],
  options: AggregateQualityOptions = {},
): QualityAggregate {
  const degradedAtOrBelow = options.degradedAtOrBelow ?? DEFAULT_DEGRADED_SCORE;

  const scoresByDirection = new Map<QualityDirection, number[]>();
  const events: QualityEvent[] = [];

  for (const sample of samples) {
    if (!Number.isFinite(sample.score)) continue;

    let scores = scoresByDirection.get(sample.direction);
    if (!scores) {
      scores = [];
      scoresByDirection.set(sample.direction, scores);
    }
    scores.push(sample.score);

    if (sample.score <= degradedAtOrBelow) {
      events.push({
        roomId: sample.roomId,
        userId: sample.userId,
        direction: sample.direction,
        score: sample.score,
        threshold: degradedAtOrBelow,
      });
    }
  }

  const distributions: QualityDistribution[] = [];

  // Iterate the fixed direction list, not the Map, so output order is stable
  // regardless of the order legs happened to register.
  for (const direction of QUALITY_DIRECTIONS) {
    const scores = scoresByDirection.get(direction);
    if (!scores || scores.length === 0) continue;

    scores.sort((a, b) => a - b);

    distributions.push({
      direction,
      sampleCount: scores.length,
      statistics: {
        min: scores[0]!,
        p01: percentile(scores, 1),
        p10: percentile(scores, 10),
        p50: percentile(scores, 50),
        p90: percentile(scores, 90),
        max: scores[scores.length - 1]!,
      },
    });
  }

  return { distributions, events };
}

/**
 * Nearest-rank percentile over an ascending-sorted, non-empty array.
 *
 * Nearest-rank always returns an observed value, never an interpolated one —
 * with a small fleet that matters, because an interpolated p01 can report a
 * score no participant actually experienced.
 */
function percentile(sortedAscending: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index]!;
}
