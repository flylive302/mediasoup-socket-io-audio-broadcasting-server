/**
 * observability-audio-quality 02 — the deep RTP statistics sweep.
 *
 * The sweep is a PULL: one round trip into the media worker per live leg,
 * unlike ticket 01's free push. These tests cover the three things that make
 * that safe — picking the right stats entry, refusing to spend a round trip on
 * a leg that carries no audio, and never letting one leg fail the sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "@src/config/index.js";
import type { ClientLegHandle } from "@src/domains/media/routerManager.js";
import {
  isSweepable,
  selectStatsEntry,
  runRtpStatisticsSweep,
  startRtpStatisticsSweeper,
  stopRtpStatisticsSweeper,
} from "@src/domains/media/quality/rtpStatisticsSweeper.js";
import { rtpStatisticsRegistry } from "@src/domains/media/quality/rtpStatisticsRegistry.js";

const leg = { roomId: "room-9", userId: "123" };

/** The consumer's own send stream — what direction=receiving must measure. */
const OUTBOUND = {
  type: "outbound-rtp",
  fractionLost: 3,
  roundTripTime: 42.5,
};

/** The UPSTREAM producer's receive stream, returned alongside it. */
const INBOUND = {
  type: "inbound-rtp",
  fractionLost: 99,
  jitter: 7,
  roundTripTime: 11.1,
};

type StatsEntry = Record<string, unknown>;

const createHandle = (
  overrides: {
    streamId?: string;
    direction?: "sending" | "receiving";
    stats?: StatsEntry[];
    paused?: boolean;
    producerPaused?: boolean;
    closed?: boolean;
    getStats?: () => Promise<StatsEntry[]>;
  } = {},
): ClientLegHandle => {
  const direction = overrides.direction ?? "receiving";
  return {
    streamId: overrides.streamId ?? "stream-1",
    direction,
    leg,
    stream: {
      paused: overrides.paused ?? false,
      producerPaused: overrides.producerPaused ?? false,
      closed: overrides.closed ?? false,
      getStats:
        overrides.getStats ??
        vi.fn().mockResolvedValue(overrides.stats ?? [OUTBOUND, INBOUND]),
    },
  } as unknown as ClientLegHandle;
};

const sourceOf = (handles: ClientLegHandle[]) => ({
  listClientLegs: () => handles,
});

describe("RTP statistics sweeper", () => {
  beforeEach(() => {
    rtpStatisticsRegistry.clear();
  });

  afterEach(() => {
    stopRtpStatisticsSweeper();
    rtpStatisticsRegistry.clear();
    vi.useRealTimers();
  });

  describe("selectStatsEntry", () => {
    /**
     * THE double-count guard. `consumer.getStats()` returns both the
     * consumer's own outbound stream and the upstream producer's inbound one.
     * Taking the inbound entry would publish the SENDER's loss under
     * direction=receiving — the same double-count ticket 01 rejected when it
     * refused to record `producerScore`.
     */
    it("takes the consumer's own outbound entry, never the upstream producer's", () => {
      expect(selectStatsEntry("receiving", [OUTBOUND, INBOUND])).toBe(OUTBOUND);
      // Order must not matter — the discriminator is `type`, not position.
      expect(selectStatsEntry("receiving", [INBOUND, OUTBOUND])).toBe(OUTBOUND);
    });

    it("yields nothing for a consumer with only an inbound entry — no positional fallback", () => {
      expect(selectStatsEntry("receiving", [INBOUND])).toBeUndefined();
    });

    it("takes the producer's inbound entry", () => {
      expect(selectStatsEntry("sending", [INBOUND])).toBe(INBOUND);
    });

    it("yields nothing for a producer with no inbound entry", () => {
      expect(selectStatsEntry("sending", [OUTBOUND])).toBeUndefined();
      expect(selectStatsEntry("sending", [])).toBeUndefined();
    });
  });

  describe("isSweepable", () => {
    it("accepts a live unpaused leg", () => {
      expect(isSweepable(createHandle())).toBe(true);
    });

    // Same exclusion as ticket 01's score path: a paused leg carries no audio,
    // so its numbers measure nobody's experience. Checked BEFORE getStats, so
    // it also saves the round trip.
    it("rejects a paused leg", () => {
      expect(isSweepable(createHandle({ paused: true }))).toBe(false);
    });

    it("rejects a consumer whose upstream producer is paused", () => {
      expect(isSweepable(createHandle({ producerPaused: true }))).toBe(false);
    });

    it("ignores producerPaused on a sending leg", () => {
      const handle = createHandle({
        direction: "sending",
        producerPaused: true,
      });
      expect(isSweepable(handle)).toBe(true);
    });

    it("rejects a closed leg", () => {
      expect(isSweepable(createHandle({ closed: true }))).toBe(false);
    });
  });

  describe("runRtpStatisticsSweep", () => {
    it("records the outbound statistics of a receiving leg", async () => {
      const samples = await runRtpStatisticsSweep(sourceOf([createHandle()]));

      expect(samples).toEqual([
        {
          streamId: "stream-1",
          direction: "receiving",
          roomId: "room-9",
          userId: "123",
          fractionLost: 3,
          roundTripTime: 42.5,
        },
      ]);
      // The upstream producer's jitter=7 and fractionLost=99 must not appear.
      expect(samples[0]).not.toHaveProperty("jitter");
    });

    it("omits an absent statistic rather than defaulting it to zero", async () => {
      // Zero loss and zero RTT read as PERFECT — the mirror of ticket 01's
      // rule that a zero score reads as worst-possible.
      const handle = createHandle({ stats: [{ type: "outbound-rtp" }] });
      const [sample] = await runRtpStatisticsSweep(sourceOf([handle]));

      expect(sample).not.toHaveProperty("fractionLost");
      expect(sample).not.toHaveProperty("jitter");
      expect(sample).not.toHaveProperty("roundTripTime");
    });

    it("skips non-finite statistics", async () => {
      const handle = createHandle({
        stats: [
          {
            type: "outbound-rtp",
            fractionLost: Number.NaN,
            roundTripTime: Number.POSITIVE_INFINITY,
            jitter: 4,
          },
        ],
      });
      const [sample] = await runRtpStatisticsSweep(sourceOf([handle]));

      expect(sample).toEqual({
        streamId: "stream-1",
        direction: "receiving",
        roomId: "room-9",
        userId: "123",
        jitter: 4,
      });
    });

    it("does not spend a round trip on a paused leg", async () => {
      const getStats = vi.fn().mockResolvedValue([OUTBOUND]);
      const handle = createHandle({ paused: true, getStats });

      await runRtpStatisticsSweep(sourceOf([handle]));

      expect(getStats).not.toHaveBeenCalled();
    });

    // A leg can close between enumeration and the round trip; getStats then
    // rejects. One bad leg must never cost the whole sweep.
    it("survives a leg whose getStats rejects", async () => {
      const failing = createHandle({
        streamId: "boom",
        getStats: vi.fn().mockRejectedValue(new Error("closed")),
      });
      const healthy = createHandle({ streamId: "ok" });

      const samples = await runRtpStatisticsSweep(sourceOf([failing, healthy]));

      expect(samples).toHaveLength(1);
      expect(samples[0]?.streamId).toBe("ok");
    });

    it("replaces the registry wholesale so a vanished leg cannot linger", async () => {
      await runRtpStatisticsSweep(sourceOf([createHandle({ streamId: "a" })]));
      expect(rtpStatisticsRegistry.snapshot().map((s) => s.streamId)).toEqual([
        "a",
      ]);

      await runRtpStatisticsSweep(sourceOf([createHandle({ streamId: "b" })]));
      expect(rtpStatisticsRegistry.snapshot().map((s) => s.streamId)).toEqual([
        "b",
      ]);

      await runRtpStatisticsSweep(sourceOf([]));
      expect(rtpStatisticsRegistry.size).toBe(0);
    });

    /**
     * A full fan-out would fire one request per live leg down a single worker
     * channel — the measurement degrading the thing it measures.
     */
    it("never exceeds the configured concurrency ceiling", async () => {
      const original = config.AUDIO_RTP_SWEEP_CONCURRENCY;
      config.AUDIO_RTP_SWEEP_CONCURRENCY = 3;

      let inFlight = 0;
      let peak = 0;
      const getStats = vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return [OUTBOUND];
      });

      const handles = Array.from({ length: 20 }, (_, i) =>
        createHandle({ streamId: `s-${i}`, getStats }),
      );

      try {
        const samples = await runRtpStatisticsSweep(sourceOf(handles));
        expect(samples).toHaveLength(20);
        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1);
      } finally {
        config.AUDIO_RTP_SWEEP_CONCURRENCY = original;
      }
    });
  });

  describe("the interval", () => {
    /**
     * Ticket 01's tick is synchronous and cannot overlap itself. This one is
     * async and can. Queueing sweeps behind a worker that is already
     * struggling is how a metrics poller turns a slow instance into a dead
     * one, so an overlapping tick is skipped, not queued.
     */
    it("skips a tick while a sweep is still in flight", async () => {
      vi.useFakeTimers();
      const original = config.AUDIO_RTP_SWEEP_INTERVAL_MS;
      config.AUDIO_RTP_SWEEP_INTERVAL_MS = 1000;

      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const getStats = vi.fn(async () => {
        await blocked;
        return [OUTBOUND];
      });

      try {
        startRtpStatisticsSweeper(sourceOf([createHandle({ getStats })]));

        await vi.advanceTimersByTimeAsync(1000);
        expect(getStats).toHaveBeenCalledTimes(1);

        // Three more intervals pass while the first sweep is still blocked.
        await vi.advanceTimersByTimeAsync(3000);
        expect(getStats).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(0);

        // Once it drains, the next tick runs normally.
        await vi.advanceTimersByTimeAsync(1000);
        expect(getStats).toHaveBeenCalledTimes(2);
      } finally {
        config.AUDIO_RTP_SWEEP_INTERVAL_MS = original;
      }
    });

    it("stops cleanly and runs no further sweeps", async () => {
      vi.useFakeTimers();
      const original = config.AUDIO_RTP_SWEEP_INTERVAL_MS;
      config.AUDIO_RTP_SWEEP_INTERVAL_MS = 1000;

      const getStats = vi.fn().mockResolvedValue([OUTBOUND]);

      try {
        startRtpStatisticsSweeper(sourceOf([createHandle({ getStats })]));
        await vi.advanceTimersByTimeAsync(1000);
        expect(getStats).toHaveBeenCalledTimes(1);

        stopRtpStatisticsSweeper();
        await vi.advanceTimersByTimeAsync(5000);
        expect(getStats).toHaveBeenCalledTimes(1);
      } finally {
        config.AUDIO_RTP_SWEEP_INTERVAL_MS = original;
      }
    });
  });
});
