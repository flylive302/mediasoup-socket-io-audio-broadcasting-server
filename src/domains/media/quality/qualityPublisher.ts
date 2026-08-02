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
