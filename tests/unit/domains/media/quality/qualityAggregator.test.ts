import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEGRADED_SCORE,
  QUALITY_STATISTICS,
  aggregateQuality,
  type QualityDirection,
  type QualitySample,
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
      const result = aggregateQuality(
        scores([5, 3, 9, 1, 7, 10, 2, 8, 4, 6]),
      );
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
});
