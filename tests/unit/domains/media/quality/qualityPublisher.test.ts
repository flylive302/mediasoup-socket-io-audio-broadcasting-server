/**
 * observability-audio-quality 02 — publisher reset scoping.
 *
 * Ticket 01's publisher resets before it sets, so a direction that goes quiet
 * stops publishing rather than freezing its last value forever. Ticket 02 adds
 * a SECOND publish path fed by a different mechanism on a different interval —
 * scores are pushed by the SFU, RTP statistics are polled.
 *
 * 🔴 The failure this file exists to catch: if the two halves shared a reset,
 * whichever published last would blank the other's series. With a 15s publish
 * tick and a 60s sweep that would silently zero the RTP metrics for most of
 * every minute, and the scrape would look like a healthy fleet reporting
 * nothing rather than a broken instrument.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "@src/config/index.js";
import { metrics } from "@src/infrastructure/metrics.js";
import {
  publishQualityDistributions,
  publishRtpDistributions,
} from "@src/domains/media/quality/qualityPublisher.js";
import type {
  QualityDistribution,
  RtpDistribution,
} from "@src/domains/media/quality/qualityAggregator.js";

const STATISTICS = {
  min: 1,
  p01: 2,
  p10: 3,
  p50: 4,
  p90: 5,
  max: 6,
};

const scoreDistribution: QualityDistribution = {
  direction: "sending",
  sampleCount: 12,
  statistics: STATISTICS,
};

const rtpDistribution: RtpDistribution = {
  metric: "round_trip_time",
  direction: "receiving",
  sampleCount: 7,
  statistics: STATISTICS,
};

const resetAll = () => {
  metrics.audioQualityScore.reset();
  metrics.audioQualitySamples.reset();
  metrics.audioRtpFractionLost.reset();
  metrics.audioRtpJitter.reset();
  metrics.audioRtpRoundTripTimeMs.reset();
  metrics.audioRtpSamples.reset();
};

const valueCount = async (
  gauge: (typeof metrics)["audioQualityScore"],
): Promise<number> => (await gauge.get()).values.length;

describe("audio-quality publisher reset scoping", () => {
  let originalInstanceId: string;

  beforeEach(() => {
    originalInstanceId = config.INSTANCE_ID;
    config.INSTANCE_ID = "i-test-instance";
    resetAll();
  });

  afterEach(() => {
    config.INSTANCE_ID = originalInstanceId;
    resetAll();
  });

  it("publishing scores does not clear the RTP series", async () => {
    publishRtpDistributions([rtpDistribution]);
    expect(await valueCount(metrics.audioRtpRoundTripTimeMs)).toBe(6);
    expect(await valueCount(metrics.audioRtpSamples)).toBe(1);

    // The fast tick fires again with no new sweep behind it.
    publishQualityDistributions([scoreDistribution]);

    expect(await valueCount(metrics.audioRtpRoundTripTimeMs)).toBe(6);
    expect(await valueCount(metrics.audioRtpSamples)).toBe(1);
  });

  it("publishing RTP statistics does not clear the score series", async () => {
    publishQualityDistributions([scoreDistribution]);
    expect(await valueCount(metrics.audioQualityScore)).toBe(6);
    expect(await valueCount(metrics.audioQualitySamples)).toBe(1);

    publishRtpDistributions([rtpDistribution]);

    expect(await valueCount(metrics.audioQualityScore)).toBe(6);
    expect(await valueCount(metrics.audioQualitySamples)).toBe(1);
  });

  it("each RTP metric lands on its own gauge, and the others stay empty", async () => {
    publishRtpDistributions([rtpDistribution]);

    expect(await valueCount(metrics.audioRtpRoundTripTimeMs)).toBe(6);
    expect(await valueCount(metrics.audioRtpFractionLost)).toBe(0);
    expect(await valueCount(metrics.audioRtpJitter)).toBe(0);
  });

  it("a metric that stops reporting drops out rather than freezing", async () => {
    publishRtpDistributions([
      rtpDistribution,
      { ...rtpDistribution, metric: "jitter", direction: "sending" },
    ]);
    expect(await valueCount(metrics.audioRtpJitter)).toBe(6);

    // Next sweep found jitter nowhere — the series must disappear, not hold.
    publishRtpDistributions([rtpDistribution]);

    expect(await valueCount(metrics.audioRtpJitter)).toBe(0);
    expect(await valueCount(metrics.audioRtpRoundTripTimeMs)).toBe(6);
  });

  it("labels each denominator by metric so the differing counts survive", async () => {
    publishRtpDistributions([
      { ...rtpDistribution, metric: "fraction_lost", sampleCount: 9 },
      { ...rtpDistribution, metric: "jitter", sampleCount: 5 },
      { ...rtpDistribution, metric: "round_trip_time", sampleCount: 2 },
    ]);

    const samples = (await metrics.audioRtpSamples.get()).values;
    const byMetric = Object.fromEntries(
      samples.map((entry) => [entry.labels.metric, entry.value]),
    );

    expect(byMetric).toEqual({
      fraction_lost: 9,
      jitter: 5,
      round_trip_time: 2,
    });
  });
});
