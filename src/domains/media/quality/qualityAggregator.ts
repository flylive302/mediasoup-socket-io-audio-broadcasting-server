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

/**
 * The deep RTP statistics ticket 02 sweeps — the numbers that say *why* audio
 * was bad, where the score only says *that* it was.
 *
 * Named after the SFU's own field names, NOT after a unit. `roundTripTime` is
 * documented in milliseconds so the gauge may say so; `jitter` and
 * `fractionLost` have no documented unit, so their metric names must not
 * imply one. A series name is as permanent as a label.
 *
 * ⚠️ These read the OPPOSITE way to the score: for loss, jitter and RTT
 * **higher is worse**, so the interesting tail is `p90`/`max` — the mirror of
 * the score's `p01`/`p10`.
 */
export const RTP_METRICS = [
  "fraction_lost",
  "jitter",
  "round_trip_time",
] as const;

export type RtpMetric = (typeof RTP_METRICS)[number];

/**
 * One live client leg's deep statistics, pulled by the sweep.
 *
 * Every statistic is optional and independently so: the SFU omits `jitter` on
 * a send stream, and `roundTripTime` is absent until RTCP has completed a
 * round trip. An absent statistic is left out of its distribution entirely —
 * never defaulted to 0, which for loss and RTT would read as *perfect* and is
 * the same trap ticket 01 avoided at the other end of the scale.
 *
 * `roomId` / `userId` are carried under the same rule as `QualitySample`:
 * in-memory only, and the cardinality test proves they never reach a label.
 */
export interface RtpStatisticsSample {
  /** Consumer or producer id. In-memory key only — NEVER a metric label. */
  readonly streamId: string;
  readonly direction: QualityDirection;
  /** Log path only — NEVER a metric label. */
  readonly roomId: string;
  /** Log path only — NEVER a metric label. */
  readonly userId: string;
  readonly fractionLost?: number;
  readonly jitter?: number;
  /** Milliseconds. */
  readonly roundTripTime?: number;
}

/** One RTP metric's distribution in one direction. Carries no identity. */
export interface RtpDistribution {
  readonly metric: RtpMetric;
  readonly direction: QualityDirection;
  readonly sampleCount: number;
  readonly statistics: Readonly<Record<QualityStatistic, number>>;
}

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
 * A single degraded client leg, written to the log stream by ticket 03's
 * `qualityEventLogger`. Discrete, so it creates no time series and costs no
 * cardinality — this is the resolution of the tension between "an engineer
 * must be able to search by room" and ticket 01's cardinality rule.
 *
 * Carries ticket 02's deep statistics when the sweep has them for this leg,
 * because the score says only *that* audio was bad and the whole point of 02
 * is to say *why*. An event without them is still valid — the sweep runs on a
 * slower interval and may not have seen a leg that has already scored.
 *
 * ⚠️ The RTP values are the LAST SWEEP's, so they can be up to
 * `AUDIO_RTP_SWEEP_INTERVAL_MS` older than the score beside them. Same leg,
 * not necessarily the same instant. Units are the SFU's own and are NOT what
 * their names suggest — see `RtpStatisticsSample` and the gauge help text.
 */
export interface QualityEvent {
  /** The degraded consumer or producer. Log path only — never a label. */
  readonly streamId: string;
  readonly roomId: string;
  readonly userId: string;
  readonly direction: QualityDirection;
  readonly score: number;
  readonly threshold: number;
  /** Raw RTCP 0-255 byte, NOT a 0-1 fraction. Absent if not swept. */
  readonly fractionLost?: number;
  /** RTP timestamp ticks, NOT milliseconds. Absent if not swept. */
  readonly jitter?: number;
  /** Milliseconds. Absent if not swept, or 0 before RTCP completes a trip. */
  readonly roundTripTime?: number;
}

export interface QualityAggregate {
  readonly distributions: readonly QualityDistribution[];
  /** Ticket 02. Empty until a statistics sweep has run at least once. */
  readonly rtpDistributions: readonly RtpDistribution[];
  readonly events: readonly QualityEvent[];
}

export interface AggregateQualityOptions {
  /** A leg at or below this score is degraded. Ticket 03 moves it to config. */
  readonly degradedAtOrBelow?: number;
  /**
   * Ticket 02's pull-sweep results, aggregated by this same function so there
   * is exactly ONE percentile implementation and ONE direction split in the
   * epic. Passed as a separate input rather than merged into `samples`
   * because the two arrive on different intervals from different mechanisms —
   * scores are pushed by the SFU, these are polled — and a leg present in one
   * need not be present in the other.
   */
  readonly rtpSamples?: readonly RtpStatisticsSample[];
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
  const rtpSamples = options.rtpSamples ?? [];

  // Indexed once, not searched per degraded leg: during an incident nearly
  // every leg is degraded and a linear scan per event would be quadratic.
  //
  // Keyed by `streamId` ALONE, with no direction check, and that is safe
  // rather than sloppy: a stream id is one mediasoup consumer or producer, and
  // both registries derive `direction` from that same handle. Two samples
  // sharing an id therefore always agree on direction, so a check could never
  // fire. If ids ever stop being per-leg unique, this is the join to revisit.
  const rtpByStreamId = new Map<string, RtpStatisticsSample>();
  for (const sample of rtpSamples) {
    rtpByStreamId.set(sample.streamId, sample);
  }

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
      events.push(
        buildQualityEvent(
          sample,
          degradedAtOrBelow,
          rtpByStreamId.get(sample.streamId),
        ),
      );
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
      statistics: statisticsOf(scores),
    });
  }

  return {
    distributions,
    rtpDistributions: aggregateRtpStatistics(rtpSamples),
    events,
  };
}

/**
 * One degraded leg's event, with the sweep's numbers attached when it has
 * them.
 *
 * A non-finite statistic is omitted rather than written as-is: the log path
 * has the same "absent is not zero" rule as the metric path, because for loss
 * and round-trip time a zero reads as *perfect* and would send an engineer
 * looking at the wrong layer.
 */
function buildQualityEvent(
  sample: QualitySample,
  threshold: number,
  rtp: RtpStatisticsSample | undefined,
): QualityEvent {
  return {
    streamId: sample.streamId,
    roomId: sample.roomId,
    userId: sample.userId,
    direction: sample.direction,
    score: sample.score,
    threshold,
    ...(finite(rtp?.fractionLost) !== undefined && {
      fractionLost: rtp!.fractionLost,
    }),
    ...(finite(rtp?.jitter) !== undefined && { jitter: rtp!.jitter }),
    ...(finite(rtp?.roundTripTime) !== undefined && {
      roundTripTime: rtp!.roundTripTime,
    }),
  };
}

/** Keep only finite numbers — an absent statistic must stay absent. */
function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** How each RTP metric is read off a sample. */
const RTP_READERS: Readonly<
  Record<RtpMetric, (sample: RtpStatisticsSample) => number | undefined>
> = {
  fraction_lost: (sample) => sample.fractionLost,
  jitter: (sample) => sample.jitter,
  round_trip_time: (sample) => sample.roundTripTime,
};

/**
 * Same shape as the score half above, one distribution per (metric,
 * direction) pair that actually has values.
 *
 * Each metric is counted independently — a leg missing `roundTripTime` still
 * contributes its `fractionLost` — so `sampleCount` legitimately differs
 * between metrics of the same direction. That is why the denominator gauge is
 * labelled by metric.
 */
function aggregateRtpStatistics(
  samples: readonly RtpStatisticsSample[],
): RtpDistribution[] {
  const distributions: RtpDistribution[] = [];

  // Fixed metric and direction lists, not the sample order, so output order is
  // stable regardless of the order legs happened to be swept.
  for (const metric of RTP_METRICS) {
    const read = RTP_READERS[metric];

    for (const direction of QUALITY_DIRECTIONS) {
      const values: number[] = [];

      for (const sample of samples) {
        if (sample.direction !== direction) continue;
        const value = read(sample);
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        values.push(value);
      }

      if (values.length === 0) continue;

      values.sort((a, b) => a - b);

      distributions.push({
        metric,
        direction,
        sampleCount: values.length,
        statistics: statisticsOf(values),
      });
    }
  }

  return distributions;
}

/** The fixed statistic set over an ascending-sorted, non-empty array. */
function statisticsOf(
  sortedAscending: readonly number[],
): Record<QualityStatistic, number> {
  return {
    min: sortedAscending[0]!,
    p01: percentile(sortedAscending, 1),
    p10: percentile(sortedAscending, 10),
    p50: percentile(sortedAscending, 50),
    p90: percentile(sortedAscending, 90),
    max: sortedAscending[sortedAscending.length - 1]!,
  };
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
