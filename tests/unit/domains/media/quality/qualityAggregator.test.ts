import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEGRADED_SCORE,
  QUALITY_STATISTICS,
  aggregateQuality,
  type QualityDirection,
  type QualitySample,
  type RtpStatisticsSample,
  type RtpDistribution,
  type RtpMetric,
} from "@src/domains/media/quality/qualityAggregator.js";

const sample = (
  score: number,
  direction: QualityDirection = "receiving",
  index = 0,
): QualitySample => ({
  streamId: `stream-${direction}-${index}-${score}`,
  direction,
  score,
  roomId: "room-1",
  userId: "42",
});

const scores = (
  values: number[],
  direction: QualityDirection = "receiving",
): QualitySample[] => values.map((v, i) => sample(v, direction, i));

const forDirection = (
  result: ReturnType<typeof aggregateQuality>,
  direction: QualityDirection,
) => result.distributions.find((d) => d.direction === direction);

describe("aggregateQuality", () => {
  describe("empty input", () => {
    it("returns no distributions and no events", () => {
      const result = aggregateQuality([]);
      expect(result.distributions).toEqual([]);
      expect(result.events).toEqual([]);
    });

    it("omits a direction entirely rather than reporting it as zero", () => {
      // A score of 0 is worst-possible quality. Publishing one for "no
      // traffic" would be indistinguishable from an outage.
      const result = aggregateQuality(scores([9, 10], "sending"));
      expect(forDirection(result, "sending")).toBeDefined();
      expect(forDirection(result, "receiving")).toBeUndefined();
    });
  });

  describe("single-sample input", () => {
    it("reports the same value for every statistic", () => {
      const result = aggregateQuality([sample(7)]);
      const dist = forDirection(result, "receiving");

      expect(dist?.sampleCount).toBe(1);
      for (const statistic of QUALITY_STATISTICS) {
        expect(dist?.statistics[statistic]).toBe(7);
      }
    });
  });

  describe("percentile boundaries", () => {
    it("uses nearest-rank, so every statistic is an observed value", () => {
      // 1..10 ascending. Nearest-rank index = ceil(p/100 * n) - 1.
      const result = aggregateQuality(scores([5, 3, 9, 1, 7, 10, 2, 8, 4, 6]));
      const stats = forDirection(result, "receiving")!.statistics;

      expect(stats.min).toBe(1);
      expect(stats.p01).toBe(1); // ceil(0.1) - 1 = 0
      expect(stats.p10).toBe(1); // ceil(1.0) - 1 = 0
      expect(stats.p50).toBe(5); // ceil(5.0) - 1 = 4
      expect(stats.p90).toBe(9); // ceil(9.0) - 1 = 8
      expect(stats.max).toBe(10);
    });

    it("clamps p100-equivalent ranks to the last element", () => {
      const stats = forDirection(
        aggregateQuality(scores([2, 4])),
        "receiving",
      )!.statistics;
      expect(stats.p90).toBe(4);
      expect(stats.max).toBe(4);
    });

    it("does not mutate the caller's array order", () => {
      const input = scores([9, 1, 5]);
      const before = input.map((s) => s.score);
      aggregateQuality(input);
      expect(input.map((s) => s.score)).toEqual(before);
    });

    it("splits statistics per direction", () => {
      const result = aggregateQuality([
        ...scores([10, 10], "sending"),
        ...scores([2, 2], "receiving"),
      ]);

      expect(forDirection(result, "sending")!.statistics.min).toBe(10);
      expect(forDirection(result, "receiving")!.statistics.min).toBe(2);
      expect(forDirection(result, "sending")!.sampleCount).toBe(2);
    });

    it("ignores non-finite scores rather than poisoning the percentiles", () => {
      const result = aggregateQuality([
        sample(8),
        { ...sample(0), score: Number.NaN },
        { ...sample(0), score: Number.POSITIVE_INFINITY },
      ]);
      const dist = forDirection(result, "receiving");

      expect(dist?.sampleCount).toBe(1);
      expect(dist?.statistics.min).toBe(8);
    });
  });

  describe("all-degraded input", () => {
    it("emits one event per degraded leg and still reports the distribution", () => {
      const result = aggregateQuality(scores([1, 2, 3]));

      expect(result.events).toHaveLength(3);
      expect(forDirection(result, "receiving")!.statistics.max).toBe(3);
    });

    it("carries room, user, direction and the measured value on each event", () => {
      const result = aggregateQuality([
        {
          streamId: "consumer-abc",
          direction: "receiving",
          score: 2,
          roomId: "room-77",
          userId: "901",
        },
      ]);

      expect(result.events[0]).toEqual({
        streamId: "consumer-abc",
        roomId: "room-77",
        userId: "901",
        direction: "receiving",
        score: 2,
        threshold: DEFAULT_DEGRADED_SCORE,
      });
    });

    it("treats the threshold as inclusive and honours an override", () => {
      expect(
        aggregateQuality([sample(DEFAULT_DEGRADED_SCORE)]).events,
      ).toHaveLength(1);
      expect(
        aggregateQuality([sample(DEFAULT_DEGRADED_SCORE + 1)]).events,
      ).toHaveLength(0);
      expect(
        aggregateQuality([sample(8)], { degradedAtOrBelow: 9 }).events,
      ).toHaveLength(1);
    });

    it("emits no events when every leg is healthy", () => {
      expect(aggregateQuality(scores([9, 10, 10])).events).toEqual([]);
    });
  });

  describe("the cardinality rule", () => {
    it("keeps room, user and stream identity out of the distributions", () => {
      const result = aggregateQuality(scores([4, 8]));
      const serialised = JSON.stringify(result.distributions);

      expect(serialised).not.toContain("room");
      expect(serialised).not.toContain("user");
      expect(serialised).not.toContain("stream");
    });
  });

  describe("RTP statistics distributions", () => {
    const rtpSample = (
      overrides: Partial<RtpStatisticsSample> = {},
    ): RtpStatisticsSample => ({
      streamId: `stream-${Math.random().toString(36).slice(2)}`,
      direction: "receiving",
      roomId: "room-1",
      userId: "42",
      ...overrides,
    });

    it("is [] when no rtpSamples are passed, and leaves distributions/events unaffected", () => {
      const result = aggregateQuality(scores([9, 3]));

      expect(result.rtpDistributions).toEqual([]);
      // Score-only behaviour is untouched: one direction, one degraded event.
      expect(result.distributions).toHaveLength(1);
      expect(result.events).toHaveLength(1);
    });

    it("computes rtpDistributions even when samples is empty — the two inputs are independent", () => {
      const result = aggregateQuality([], {
        rtpSamples: [rtpSample({ fractionLost: 0.1 })],
      });

      expect(result.distributions).toEqual([]);
      expect(result.rtpDistributions.length).toBeGreaterThan(0);
    });

    it("computes percentiles for one RTP metric using the same nearest-rank rule as the score aggregator", () => {
      // Same 1..10 shuffled set as the "percentile boundaries" describe above,
      // so the hand-computed nearest-rank values are directly comparable.
      const values = [5, 3, 9, 1, 7, 10, 2, 8, 4, 6];
      const rtpSamples = values.map((v) =>
        rtpSample({ direction: "sending", fractionLost: v }),
      );

      const result = aggregateQuality([], { rtpSamples });
      const dist = result.rtpDistributions.find(
        (d) => d.metric === "fraction_lost" && d.direction === "sending",
      );

      expect(dist).toBeDefined();
      expect(dist!.statistics.min).toBe(1);
      expect(dist!.statistics.p01).toBe(1); // ceil(0.1) - 1 = 0
      expect(dist!.statistics.p10).toBe(1); // ceil(1.0) - 1 = 0
      expect(dist!.statistics.p50).toBe(5); // ceil(5.0) - 1 = 4
      expect(dist!.statistics.p90).toBe(9); // ceil(9.0) - 1 = 8
      expect(dist!.statistics.max).toBe(10);
    });

    it("counts each metric independently — legs missing a field still contribute the fields they have", () => {
      const rtpSamples: RtpStatisticsSample[] = [
        rtpSample({ fractionLost: 0.1, jitter: 5, roundTripTime: 20 }),
        rtpSample({ fractionLost: 0.2, jitter: 8 }),
        rtpSample({ fractionLost: 0.3 }),
      ];

      const result = aggregateQuality([], { rtpSamples });
      const byMetric = (metric: RtpMetric) =>
        result.rtpDistributions.find(
          (d) => d.metric === metric && d.direction === "receiving",
        );

      expect(byMetric("fraction_lost")?.sampleCount).toBe(3);
      expect(byMetric("jitter")?.sampleCount).toBe(2);
      expect(byMetric("round_trip_time")?.sampleCount).toBe(1);
    });

    it("omits a (metric, direction) pair with zero values rather than reporting 0", () => {
      // 0 would read as *perfect* for loss and RTT — must be absent, not 0.
      const result = aggregateQuality([], {
        rtpSamples: [rtpSample({ direction: "sending", fractionLost: 0.1 })],
      });

      const jitterSending = result.rtpDistributions.find(
        (d) => d.metric === "jitter" && d.direction === "sending",
      );
      const rttSending = result.rtpDistributions.find(
        (d) => d.metric === "round_trip_time" && d.direction === "sending",
      );

      expect(jitterSending).toBeUndefined();
      expect(rttSending).toBeUndefined();
    });

    it("skips non-finite values, omitting the entry entirely if nothing finite remains", () => {
      const result = aggregateQuality([], {
        rtpSamples: [
          rtpSample({ fractionLost: Number.NaN }),
          rtpSample({ fractionLost: Number.POSITIVE_INFINITY }),
          rtpSample({ jitter: 4 }),
        ],
      });

      const fractionLost = result.rtpDistributions.find(
        (d) => d.metric === "fraction_lost" && d.direction === "receiving",
      );
      const jitter = result.rtpDistributions.find(
        (d) => d.metric === "jitter" && d.direction === "receiving",
      );

      expect(fractionLost).toBeUndefined();
      expect(jitter?.sampleCount).toBe(1);
    });

    it("represents both directions and keeps output order stable regardless of input order", () => {
      const sendingSample = rtpSample({
        direction: "sending",
        fractionLost: 0.1,
        jitter: 1,
        roundTripTime: 10,
      });
      const receivingSample = rtpSample({
        direction: "receiving",
        fractionLost: 0.2,
        jitter: 2,
        roundTripTime: 20,
      });

      const resultA = aggregateQuality([], {
        rtpSamples: [sendingSample, receivingSample],
      });
      const resultB = aggregateQuality([], {
        rtpSamples: [receivingSample, sendingSample],
      });

      const shape = (dists: readonly RtpDistribution[]) =>
        dists.map((d) => `${d.metric}:${d.direction}`);

      expect(shape(resultA.rtpDistributions)).toEqual([
        "fraction_lost:sending",
        "fraction_lost:receiving",
        "jitter:sending",
        "jitter:receiving",
        "round_trip_time:sending",
        "round_trip_time:receiving",
      ]);
      expect(shape(resultB.rtpDistributions)).toEqual(
        shape(resultA.rtpDistributions),
      );
    });

    it("carries no room, user or stream identity on a distribution entry", () => {
      const result = aggregateQuality([], {
        rtpSamples: [rtpSample({ fractionLost: 0.1 })],
      });
      const [dist] = result.rtpDistributions;

      expect(dist).toBeDefined();
      expect(Object.keys(dist!).sort()).toEqual(
        ["metric", "direction", "sampleCount", "statistics"].sort(),
      );
    });
  });

  describe("streamId and the rtpSamples join on events", () => {
    const qualitySample = (
      streamId: string,
      score: number,
      direction: QualityDirection = "receiving",
    ): QualitySample => ({
      streamId,
      direction,
      score,
      roomId: "room-1",
      userId: "42",
    });

    const rtpFor = (
      streamId: string,
      overrides: Partial<RtpStatisticsSample> = {},
    ): RtpStatisticsSample => ({
      streamId,
      direction: "receiving",
      roomId: "room-1",
      userId: "42",
      ...overrides,
    });

    it("carries the streamId of the degraded leg on its event", () => {
      const result = aggregateQuality([qualitySample("consumer-abc", 2)]);
      expect(result.events[0]?.streamId).toBe("consumer-abc");
    });

    it("attaches the matching rtp sample's fractionLost, jitter and roundTripTime by streamId", () => {
      // Two degraded legs, two rtp samples — proves the join picks each
      // leg's OWN sample rather than the first one in the array.
      const result = aggregateQuality(
        [qualitySample("consumer-a", 1), qualitySample("consumer-b", 2)],
        {
          rtpSamples: [
            rtpFor("consumer-a", {
              fractionLost: 0.1,
              jitter: 5,
              roundTripTime: 20,
            }),
            rtpFor("consumer-b", {
              fractionLost: 0.4,
              jitter: 9,
              roundTripTime: 50,
            }),
          ],
        },
      );

      const eventA = result.events.find((e) => e.streamId === "consumer-a");
      const eventB = result.events.find((e) => e.streamId === "consumer-b");

      expect(eventA).toMatchObject({
        fractionLost: 0.1,
        jitter: 5,
        roundTripTime: 20,
      });
      expect(eventB).toMatchObject({
        fractionLost: 0.4,
        jitter: 9,
        roundTripTime: 50,
      });
    });

    it("has no fractionLost, jitter or roundTripTime keys when no rtp sample matches the degraded leg's streamId", () => {
      const result = aggregateQuality([qualitySample("consumer-abc", 2)], {
        rtpSamples: [
          rtpFor("some-other-stream", {
            fractionLost: 0.1,
            jitter: 5,
            roundTripTime: 20,
          }),
        ],
      });

      const event = result.events[0]!;
      // The keys must be OMITTED, not present-and-undefined.
      expect(event).not.toHaveProperty("fractionLost");
      expect(event).not.toHaveProperty("jitter");
      expect(event).not.toHaveProperty("roundTripTime");
    });

    it("omits a statistic that's absent on the matching rtp sample rather than writing it through", () => {
      const result = aggregateQuality([qualitySample("consumer-abc", 2)], {
        rtpSamples: [
          // jitter intentionally absent
          rtpFor("consumer-abc", { fractionLost: 0.1, roundTripTime: 20 }),
        ],
      });

      const event = result.events[0]!;
      expect(event.fractionLost).toBe(0.1);
      expect(event.roundTripTime).toBe(20);
      expect(event).not.toHaveProperty("jitter");
    });

    it("omits a statistic that's non-finite on the matching rtp sample rather than writing it through", () => {
      // NaN fractionLost is the dangerous case: a written-through garbage
      // value would read as PERFECT (0 loss), not as "no data".
      const result = aggregateQuality([qualitySample("consumer-abc", 2)], {
        rtpSamples: [
          rtpFor("consumer-abc", {
            fractionLost: Number.NaN,
            jitter: Number.POSITIVE_INFINITY,
            roundTripTime: 20,
          }),
        ],
      });

      const event = result.events[0]!;
      expect(event.roundTripTime).toBe(20);
      expect(event).not.toHaveProperty("fractionLost");
      expect(event).not.toHaveProperty("jitter");
    });

    it("produces no event for an rtp sample whose streamId matches a healthy leg", () => {
      const result = aggregateQuality([qualitySample("consumer-healthy", 9)], {
        rtpSamples: [rtpFor("consumer-healthy", { fractionLost: 0.1 })],
      });

      expect(result.events).toEqual([]);
      // Proves the sample was actually read by the join, not merely
      // ignored — the join must not manufacture events either way.
      expect(result.rtpDistributions.length).toBeGreaterThan(0);
    });

    it("computes the same rtpDistributions whether or not the matching leg is degraded", () => {
      const rtpSamples: RtpStatisticsSample[] = [
        rtpFor("consumer-x", {
          fractionLost: 0.2,
          jitter: 4,
          roundTripTime: 30,
        }),
      ];

      const degraded = aggregateQuality([qualitySample("consumer-x", 2)], {
        rtpSamples,
      });
      const healthy = aggregateQuality([qualitySample("consumer-x", 9)], {
        rtpSamples,
      });

      expect(degraded.rtpDistributions).toEqual(healthy.rtpDistributions);
    });

    it("reflects a degradedAtOrBelow override on the event's threshold, not the default", () => {
      const result = aggregateQuality([qualitySample("consumer-abc", 8)], {
        degradedAtOrBelow: 9,
      });

      expect(result.events[0]?.threshold).toBe(9);
      expect(result.events[0]?.threshold).not.toBe(DEFAULT_DEGRADED_SCORE);
    });
  });
});
