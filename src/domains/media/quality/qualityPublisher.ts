/**
 * Thin adapter: aggregated distributions → Prometheus gauges.
 *
 * The only thing in the quality path allowed to write the registry. Kept
 * separate from the aggregator so the percentile maths stays a pure function,
 * and separate from the sampler so the interval lifecycle stays trivial.
 */
import { config } from "@src/config/index.js";
import { metrics } from "@src/infrastructure/metrics.js";
import {
  QUALITY_STATISTICS,
  type QualityDistribution,
  type RtpDistribution,
  type RtpMetric,
} from "./qualityAggregator.js";

/**
 * Publish one tick's distributions.
 *
 * Resets first, then sets only the label sets that actually have samples —
 * the same discipline as `updateWorkerMetrics`. Without the reset, a
 * direction that went quiet would keep publishing its last p50 forever and
 * an emptied fleet would look healthy.
 *
 * `INSTANCE_ID` is read here, per tick, and never at module scope: it is
 * resolved asynchronously by `initializeConfig()` and is the empty string
 * until that await completes (same constraint as cloudwatch.ts and
 * instrument.ts).
 */
export function publishQualityDistributions(
  distributions: readonly QualityDistribution[],
): void {
  metrics.audioQualityScore.reset();
  metrics.audioQualitySamples.reset();

  const region = config.AWS_REGION;
  const instance = config.INSTANCE_ID;

  for (const distribution of distributions) {
    const { direction } = distribution;

    metrics.audioQualitySamples.set(
      { region, instance, direction },
      distribution.sampleCount,
    );

    for (const statistic of QUALITY_STATISTICS) {
      metrics.audioQualityScore.set(
        { region, instance, direction, statistic },
        distribution.statistics[statistic],
      );
    }
  }
}

/** The gauge each RTP metric is published on. Closed set, closed enum. */
const RTP_GAUGES: Readonly<
  Record<RtpMetric, (typeof metrics)["audioRtpJitter"]>
> = {
  fraction_lost: metrics.audioRtpFractionLost,
  jitter: metrics.audioRtpJitter,
  round_trip_time: metrics.audioRtpRoundTripTimeMs,
};

/**
 * Publish one tick's deep RTP distributions (observability-audio-quality 02).
 *
 * 🔴 THE RESET SCOPE IS THE POINT. This resets ONLY the RTP gauges and
 * `publishQualityDistributions` resets ONLY the score gauges — never a shared
 * `metricsRegistry.resetMetrics()`. The two halves are fed by different
 * mechanisms on different intervals (scores are pushed, these are polled), so
 * a shared reset would let whichever half published last blank the other's
 * series for the rest of the interval. There is a test for exactly that.
 */
export function publishRtpDistributions(
  distributions: readonly RtpDistribution[],
): void {
  metrics.audioRtpFractionLost.reset();
  metrics.audioRtpJitter.reset();
  metrics.audioRtpRoundTripTimeMs.reset();
  metrics.audioRtpSamples.reset();

  const region = config.AWS_REGION;
  const instance = config.INSTANCE_ID;

  for (const distribution of distributions) {
    const { direction, metric } = distribution;

    metrics.audioRtpSamples.set(
      { region, instance, direction, metric },
      distribution.sampleCount,
    );

    const gauge = RTP_GAUGES[metric];

    for (const statistic of QUALITY_STATISTICS) {
      gauge.set(
        { region, instance, direction, statistic },
        distribution.statistics[statistic],
      );
    }
  }
}
