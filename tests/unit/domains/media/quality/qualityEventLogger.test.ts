/**
 * observability-audio-quality 03 — the complaint path.
 *
 * 🔴 THESE TESTS READ THE REAL LOGGER'S SERIALIZED OUTPUT, not a mock's call
 * arguments, and that is the whole point of the file. The deliverable is a
 * record an engineer can filter by `roomId` in CloudWatch Insights; a mocked
 * `logger.warn` would pass just as happily if the fields were nested under a
 * `quality: {…}` object, which reads identically in a terminal and returns
 * ZERO ROWS for a room that did report. Only the parsed JSON proves it.
 *
 * The capture works by swapping pino's own destination symbol, so every real
 * option — the correlation mixin, the err/error serializers, the level — is
 * still in play.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { symbols } from "pino";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { QualityEvent } from "@src/domains/media/quality/qualityAggregator.js";
import {
  QualityEventLimiter,
  logQualityEvents,
  qualityEventLimiter,
  resetQualityEventLimiter,
} from "@src/domains/media/quality/qualityEventLogger.js";
import { runQualitySamplingTick } from "@src/domains/media/quality/qualitySampler.js";
import { scoreRegistry } from "@src/domains/media/quality/scoreRegistry.js";
import { rtpStatisticsRegistry } from "@src/domains/media/quality/rtpStatisticsRegistry.js";
import { metrics } from "@src/infrastructure/metrics.js";

type LogRecord = Record<string, unknown>;

/** Real pino serialization, captured. See the file header. */
class LogCapture {
  readonly records: LogRecord[] = [];
  private readonly target = logger as unknown as Record<symbol, unknown>;
  private original: unknown;
  private originalLevel = "";

  start(): void {
    this.original = this.target[symbols.streamSym];
    this.originalLevel = logger.level;
    // Pinned so a developer's local LOG_LEVEL=error cannot silently empty the
    // capture and make every assertion below vacuous.
    logger.level = "warn";
    this.target[symbols.streamSym] = {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim()) this.records.push(JSON.parse(line) as LogRecord);
        }
      },
    };
  }

  stop(): void {
    this.target[symbols.streamSym] = this.original;
    logger.level = this.originalLevel;
  }

  /** Only this ticket's records — pino writes other things too. */
  degraded(): LogRecord[] {
    return this.records.filter((r) => r.event === "audio_quality_degraded");
  }

  truncations(): LogRecord[] {
    return this.records.filter(
      (r) => r.event === "audio_quality_degraded_truncated",
    );
  }
}

const buildEvent = (overrides: Partial<QualityEvent> = {}): QualityEvent => ({
  streamId: "stream-1",
  roomId: "room-1",
  userId: "user-1",
  direction: "receiving",
  score: 2,
  threshold: 5,
  ...overrides,
});

describe("qualityEventLogger", () => {
  let capture: LogCapture;
  let originalMinInterval: number;
  let originalMaxPerTick: number;

  beforeEach(() => {
    originalMinInterval = config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS;
    originalMaxPerTick = config.AUDIO_QUALITY_EVENT_MAX_PER_TICK;
    resetQualityEventLimiter();
    capture = new LogCapture();
    capture.start();
  });

  afterEach(() => {
    capture.stop();
    config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = originalMinInterval;
    config.AUDIO_QUALITY_EVENT_MAX_PER_TICK = originalMaxPerTick;
    resetQualityEventLimiter();
  });

  describe("the record's shape — AC #2 and #7", () => {
    it("writes room, user, direction and the measured values as TOP-LEVEL keys", () => {
      logQualityEvents(
        [
          buildEvent({
            streamId: "consumer-9",
            roomId: "room-42",
            userId: "user-7",
            direction: "receiving",
            score: 3,
            threshold: 5,
          }),
        ],
        1_000,
      );

      const [record] = capture.degraded();
      expect(record).toBeDefined();

      // Asserted as own keys of the PARSED object. A nested
      // `{quality: {roomId}}` passes a mock and fails this.
      expect(Object.keys(record!)).toEqual(
        expect.arrayContaining([
          "roomId",
          "userId",
          "streamId",
          "direction",
          "score",
          "threshold",
        ]),
      );
      expect(record!.roomId).toBe("room-42");
      expect(record!.userId).toBe("user-7");
      expect(record!.streamId).toBe("consumer-9");
      expect(record!.direction).toBe("receiving");
      expect(record!.score).toBe(3);
      expect(record!.threshold).toBe(5);
    });

    it("carries ticket 02's deep statistics when the sweep has them", () => {
      logQualityEvents(
        [buildEvent({ fractionLost: 12, jitter: 340, roundTripTime: 88.5 })],
        1_000,
      );

      const [record] = capture.degraded();
      expect(record!.fractionLost).toBe(12);
      expect(record!.jitter).toBe(340);
      expect(record!.roundTripTime).toBe(88.5);
    });

    it("omits a deep statistic the sweep did not have rather than writing zero", () => {
      logQualityEvents([buildEvent({ fractionLost: 4 })], 1_000);

      const [record] = capture.degraded();
      expect(record!.fractionLost).toBe(4);
      // Zero would read as PERFECT for jitter and RTT and send an engineer to
      // the wrong layer.
      expect(record).not.toHaveProperty("jitter");
      expect(record).not.toHaveProperty("roundTripTime");
    });

    it("writes at warn, not error — one bad participant is not a page", () => {
      logQualityEvents([buildEvent()], 1_000);

      expect(capture.degraded()[0]!.level).toBe(40);
      expect(capture.degraded()[0]!.msg).toBe("Audio quality degraded");
    });
  });

  describe("searching by room — AC #8", () => {
    it("returns only that room's events when filtered by roomId", () => {
      logQualityEvents(
        [
          buildEvent({ streamId: "s-1", roomId: "room-a", userId: "u-1" }),
          buildEvent({ streamId: "s-2", roomId: "room-b", userId: "u-2" }),
          buildEvent({ streamId: "s-3", roomId: "room-b", userId: "u-3" }),
          buildEvent({ streamId: "s-4", roomId: "room-c", userId: "u-4" }),
        ],
        1_000,
      );

      // Exactly the predicate a CloudWatch Insights `filter roomId = "room-b"`
      // applies, run against the real serialized records.
      const roomB = capture.degraded().filter((r) => r.roomId === "room-b");

      expect(roomB).toHaveLength(2);
      expect(roomB.map((r) => r.userId).sort()).toEqual(["u-2", "u-3"]);
      // And the query does not sweep in the other rooms.
      expect(capture.degraded()).toHaveLength(4);
    });
  });

  describe("rate limiting — AC #4", () => {
    it("writes a leg once per window, however many ticks it stays degraded", () => {
      config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = 60_000;
      const event = buildEvent({ streamId: "persistent" });

      // 15s sampler ticks across five minutes: 20 ticks.
      for (let tick = 0; tick < 20; tick++) {
        logQualityEvents([event], tick * 15_000);
      }

      // One per 60s window, not one per tick.
      expect(capture.degraded()).toHaveLength(5);
    });

    it("emits immediately on the first tick a leg is degraded", () => {
      // AC #1 says "crosses the threshold". Level-triggered satisfies it
      // because the first acquire always succeeds.
      expect(logQualityEvents([buildEvent()], 0)).toBe(1);
    });

    it("limits each leg independently", () => {
      config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = 60_000;

      logQualityEvents([buildEvent({ streamId: "a" })], 0);
      logQualityEvents([buildEvent({ streamId: "b" })], 15_000);
      logQualityEvents(
        [buildEvent({ streamId: "a" }), buildEvent({ streamId: "b" })],
        30_000,
      );

      // Both wrote once; neither's window was consumed by the other.
      expect(capture.degraded().map((r) => r.streamId)).toEqual(["a", "b"]);
    });

    it("lets the window reopen exactly at the boundary", () => {
      config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = 60_000;
      const event = buildEvent({ streamId: "boundary" });

      expect(logQualityEvents([event], 0)).toBe(1);
      expect(logQualityEvents([event], 59_999)).toBe(0);
      expect(logQualityEvents([event], 60_000)).toBe(1);
    });
  });

  describe("the per-tick ceiling", () => {
    it("writes the worst legs first and truncates the rest", () => {
      config.AUDIO_QUALITY_EVENT_MAX_PER_TICK = 3;

      // Scores 1..8, offered best-first so ordering cannot pass by accident.
      const events = [8, 7, 6, 5, 4, 3, 2, 1].map((score) =>
        buildEvent({ streamId: `s-${score}`, score }),
      );

      expect(logQualityEvents(events, 1_000)).toBe(3);

      expect(capture.degraded().map((r) => r.score)).toEqual([1, 2, 3]);
    });

    it("writes one summary line, not N, when it truncates", () => {
      config.AUDIO_QUALITY_EVENT_MAX_PER_TICK = 2;

      logQualityEvents(
        [1, 2, 3, 4, 5].map((score) =>
          buildEvent({ streamId: `s-${score}`, score }),
        ),
        1_000,
      );

      const [summary] = capture.truncations();
      expect(capture.truncations()).toHaveLength(1);
      expect(summary!.suppressedLegs).toBe(3);
      expect(summary!.writtenLegs).toBe(2);
    });

    it("does NOT consume the window of a leg it truncated", () => {
      config.AUDIO_QUALITY_EVENT_MAX_PER_TICK = 1;
      config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = 60_000;

      const worst = buildEvent({ streamId: "worst", score: 1 });
      const other = buildEvent({ streamId: "other", score: 4 });

      logQualityEvents([worst, other], 0);
      expect(capture.degraded().map((r) => r.streamId)).toEqual(["worst"]);

      // Next tick, still inside the window. `worst` is rate-limited, so the
      // truncated leg gets its turn — it must not have burned its window
      // while being suppressed.
      logQualityEvents([worst, other], 15_000);
      expect(capture.degraded().map((r) => r.streamId)).toEqual([
        "worst",
        "other",
      ]);
    });

    it("writes no summary line when nothing was truncated", () => {
      logQualityEvents([buildEvent()], 1_000);
      expect(capture.truncations()).toHaveLength(0);
    });
  });

  describe("the limiter's memory bound", () => {
    it("prunes keys idle past the horizon", () => {
      config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = 60_000;

      logQualityEvents([buildEvent({ streamId: "gone" })], 0);
      expect(qualityEventLimiter.size).toBe(1);

      // Stream ids are unbounded over a process's life, so a map that only
      // ever grows is a slow leak — the same class as ticket 02's lingering
      // closed handles.
      logQualityEvents([], 60_000 * 4 + 1);
      expect(qualityEventLimiter.size).toBe(0);
    });

    it("never prunes a leg that is still degraded", () => {
      config.AUDIO_QUALITY_EVENT_MIN_INTERVAL_MS = 60_000;
      const event = buildEvent({ streamId: "persistent" });

      for (let tick = 0; tick < 100; tick++) {
        logQualityEvents([event], tick * 15_000);
      }

      // Its own emissions refresh the timestamp, so it survives the horizon.
      expect(qualityEventLimiter.size).toBe(1);
      expect(capture.degraded()).toHaveLength(25);
    });

    it("prunes without needing the caller to say which keys are live", () => {
      const limiter = new QualityEventLimiter();
      limiter.record("a", 0);
      limiter.record("b", 500_000);

      limiter.prune(500_000, 60_000);

      expect(limiter.size).toBe(1);
      expect(limiter.isAllowed("a", 500_000, 60_000)).toBe(true);
    });
  });

  describe("wired into the sampler tick", () => {
    beforeEach(() => {
      scoreRegistry.clear();
      rtpStatisticsRegistry.clear();
      metrics.audioQualityScore.reset();
      metrics.audioQualitySamples.reset();
    });

    afterEach(() => {
      scoreRegistry.clear();
      rtpStatisticsRegistry.clear();
    });

    it("writes a degraded leg's event through the real tick, joined to its RTP stats", () => {
      config.AUDIO_QUALITY_DEGRADED_SCORE = 5;

      scoreRegistry.record({
        streamId: "wired-1",
        direction: "receiving",
        score: 2,
        roomId: "room-wired",
        userId: "user-wired",
      });
      rtpStatisticsRegistry.replace([
        {
          streamId: "wired-1",
          direction: "receiving",
          roomId: "room-wired",
          userId: "user-wired",
          fractionLost: 26,
          roundTripTime: 140,
        },
      ]);

      runQualitySamplingTick();

      const [record] = capture.degraded();
      expect(record!.roomId).toBe("room-wired");
      expect(record!.score).toBe(2);
      // The join is what makes the complaint path diagnostic rather than just
      // confirmatory — 02 exists because the score says only *that* it was bad.
      expect(record!.fractionLost).toBe(26);
      expect(record!.roundTripTime).toBe(140);
    });

    it("writes nothing for a healthy leg", () => {
      config.AUDIO_QUALITY_DEGRADED_SCORE = 5;

      scoreRegistry.record({
        streamId: "healthy-1",
        direction: "sending",
        score: 9,
        roomId: "room-wired",
        userId: "user-wired",
      });

      runQualitySamplingTick();

      expect(capture.degraded()).toHaveLength(0);
    });

    it("takes its threshold from configuration — AC #3", () => {
      const original = config.AUDIO_QUALITY_DEGRADED_SCORE;
      config.AUDIO_QUALITY_DEGRADED_SCORE = 8;

      scoreRegistry.record({
        streamId: "threshold-1",
        direction: "sending",
        score: 7,
        roomId: "room-wired",
        userId: "user-wired",
      });

      runQualitySamplingTick();
      config.AUDIO_QUALITY_DEGRADED_SCORE = original;

      // 7 is healthy under the default of 5 and degraded under 8. If the
      // sampler ignored config this record would not exist.
      expect(capture.degraded()).toHaveLength(1);
      expect(capture.degraded()[0]!.threshold).toBe(8);
    });
  });
});
