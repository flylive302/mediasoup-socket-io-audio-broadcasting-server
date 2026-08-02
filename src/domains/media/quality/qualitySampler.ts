/**
 * Audio-quality sampler — owns its own interval and nothing else.
 *
 * Deliberately NOT attached to the existing 30s per-room walk: that loop is an
 * ownership/reconciliation job, and coupling a metrics tick to it would tie
 * scrape freshness to reconciliation timing.
 */
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  aggregateQuality,
  type QualityAggregate,
} from "./qualityAggregator.js";
import {
  publishQualityDistributions,
  publishRtpDistributions,
} from "./qualityPublisher.js";
import { rtpStatisticsRegistry } from "./rtpStatisticsRegistry.js";
import { scoreRegistry } from "./scoreRegistry.js";

let timer: NodeJS.Timeout | null = null;

/**
 * One tick: snapshot → aggregate → publish.
 *
 * BOTH halves go through ONE `aggregateQuality` call (ticket 02's AC: no
 * second aggregation path). The pushed scores and the polled RTP statistics
 * arrive by different mechanisms on different intervals, but they share one
 * percentile implementation, one direction split and one label contract.
 *
 * The RTP snapshot is whatever the last sweep produced, re-published every
 * tick. The sweep is slower than this tick on purpose, and a series that
 * blinked out between sweeps would read as "the fleet went quiet".
 *
 * Returns the whole aggregate, including the quality events that ticket 03
 * will write to the log stream. Nothing consumes `events` yet.
 */
export function runQualitySamplingTick(): QualityAggregate {
  const aggregate = aggregateQuality(scoreRegistry.snapshot(), {
    rtpSamples: rtpStatisticsRegistry.snapshot(),
  });

  publishQualityDistributions(aggregate.distributions);
  publishRtpDistributions(aggregate.rtpDistributions);

  return aggregate;
}

export function startQualitySampler(): void {
  if (timer) {
    logger.warn("Audio-quality sampler already running");
    return;
  }

  timer = setInterval(() => {
    try {
      runQualitySamplingTick();
    } catch (err) {
      // A metrics tick must never take the process down.
      logger.error({ err }, "Audio-quality sampling tick failed");
    }
  }, config.AUDIO_QUALITY_SAMPLE_INTERVAL_MS);

  logger.info(
    { intervalMs: config.AUDIO_QUALITY_SAMPLE_INTERVAL_MS },
    "Audio-quality sampler started",
  );
}

export function stopQualitySampler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
