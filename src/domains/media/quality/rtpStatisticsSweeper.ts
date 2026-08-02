/**
 * observability-audio-quality 02 — the deep RTP statistics sweep.
 *
 * Ticket 01's score is a PUSH: the SFU emits it when it changes and listening
 * is effectively free. Packet loss, jitter and round-trip time are a PULL —
 * each one is a request into the media worker — so this module polls, on its
 * own interval, and everything here exists to keep that poll cheap and safe.
 *
 * 🔴 COST IS UNMEASURED IN PRODUCTION (the ticket grades it Class C). The
 * interval and the concurrency ceiling are BOTH configuration for that
 * reason. The instrument must not become the incident.
 *
 * ⛔ COVERAGE IS NARROWER THAN "ALL AUDIO", and that is deliberate:
 *   - client mic / music producers ......... swept
 *   - client-facing consumers .............. swept
 *   - cross-region relay consumer .......... NOT swept — the object is never
 *                                            retained after creation
 *   - cross-region reverse-inbound producer  NOT swept — registered without a
 *                                            ClientLeg (default-deny)
 *   - HLS / FFmpeg broadcast mix leg ....... NOT swept — separate structure
 * A percentile that silently excluded relay traffic while appearing to cover
 * everything would be worse than no percentile, so the gauge help text says
 * so too.
 */
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { ClientLegHandle } from "../routerManager.js";
import type {
  QualityDirection,
  RtpStatisticsSample,
} from "./qualityAggregator.js";
import { rtpStatisticsRegistry } from "./rtpStatisticsRegistry.js";

/** Whatever holds the live legs. `RoomManager` in production. */
export interface ClientLegSource {
  listClientLegs(): ClientLegHandle[];
}

/**
 * The subset of a mediasoup stats entry this sweep reads.
 *
 * Every field is optional here even though mediasoup's own types declare
 * `fractionLost` and `jitter` as required numbers and `roundTripTime` as
 * optional. Measured on a local Opus bench, all three are in fact always
 * present — but the declared types are not a runtime guarantee across SFU
 * versions or stream kinds, and trusting them would publish `undefined` as a
 * data point. `finite()` is what actually decides.
 *
 * ⚠️ Values, measured not assumed: `fractionLost` is the raw RTCP 0-255 byte
 * (NOT a 0-1 fraction), `jitter` is in RTP timestamp ticks (NOT ms — /48 at
 * the 48 kHz Opus clock), and `roundTripTime` IS milliseconds. The gauge help
 * text carries the same warnings, because ticket 04 writes thresholds
 * against them.
 */
export interface RtpStreamStatsEntry {
  readonly type?: string;
  readonly fractionLost?: number;
  readonly jitter?: number;
  readonly roundTripTime?: number;
}

let timer: NodeJS.Timeout | null = null;
let sweepInFlight = false;

/**
 * GATE — a leg worth spending a worker round trip on.
 *
 * Paused legs are excluded for exactly the reason ticket 01 excluded them
 * from the score: a paused leg carries no audio, so its numbers measure
 * nobody's experience. Checked BEFORE `getStats()`, so it also saves the
 * round trip.
 */
export function isSweepable(handle: ClientLegHandle): boolean {
  const { stream } = handle;
  if (stream.closed || stream.paused) return false;

  if (handle.direction === "receiving") {
    return !(stream as { producerPaused?: boolean }).producerPaused;
  }

  return true;
}

/**
 * GATE — pick the one stats entry that describes THIS leg. Pure.
 *
 * 🔴 `consumer.getStats()` returns TWO entries: the consumer's own send
 * stream (`type: "outbound-rtp"`) and the upstream producer's receive stream
 * (`type: "inbound-rtp"`). Taking the wrong one would publish the *sender's*
 * inbound loss under `direction="receiving"` — the same double-count ticket
 * 01 rejected when it refused to record `producerScore` on a consumer. So a
 * consumer REQUIRES an `outbound-rtp` entry and yields nothing without one;
 * there is no positional fallback, because a fallback is exactly how the
 * double-count would slip back in.
 *
 * A producer's own entries are all `inbound-rtp`. Audio is never simulcast
 * here, so there is one.
 */
export function selectStatsEntry(
  direction: QualityDirection,
  entries: readonly RtpStreamStatsEntry[],
): RtpStreamStatsEntry | undefined {
  const wanted = direction === "receiving" ? "outbound-rtp" : "inbound-rtp";
  return entries.find((entry) => entry.type === wanted);
}

/** Keep only finite numbers — an absent statistic must stay absent. */
function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** EXECUTE — one leg's round trip. Returns undefined rather than throwing. */
async function sweepLeg(
  handle: ClientLegHandle,
): Promise<RtpStatisticsSample | undefined> {
  let entries: readonly RtpStreamStatsEntry[];

  try {
    entries = (await handle.stream.getStats()) as RtpStreamStatsEntry[];
  } catch (err) {
    // Expected during teardown: the leg can close between enumeration and the
    // round trip. Never let one leg fail the sweep.
    logger.debug({ err, streamId: handle.streamId }, "RTP stats read failed");
    return undefined;
  }

  const entry = selectStatsEntry(handle.direction, entries);
  if (!entry) return undefined;

  const sample: RtpStatisticsSample = {
    streamId: handle.streamId,
    direction: handle.direction,
    roomId: handle.leg.roomId,
    userId: handle.leg.userId,
    ...(finite(entry.fractionLost) !== undefined && {
      fractionLost: entry.fractionLost,
    }),
    ...(finite(entry.jitter) !== undefined && { jitter: entry.jitter }),
    ...(finite(entry.roundTripTime) !== undefined && {
      roundTripTime: entry.roundTripTime,
    }),
  };

  return sample;
}

/**
 * Run the pool with at most `limit` round trips outstanding.
 *
 * NOT `Promise.all` over every leg: at target concurrency that fires
 * thousands of simultaneous requests down one worker channel, and the
 * measurement would degrade the thing it measures.
 */
async function sweepAll(
  handles: readonly ClientLegHandle[],
  limit: number,
): Promise<RtpStatisticsSample[]> {
  const samples: RtpStatisticsSample[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < handles.length) {
      const handle = handles[next++]!;
      const sample = await sweepLeg(handle);
      if (sample) samples.push(sample);
    }
  };

  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), handles.length) },
    worker,
  );
  await Promise.all(workers);

  return samples;
}

/**
 * One sweep: enumerate → gate → pull → replace the registry.
 *
 * Publishing is NOT done here. The sampler from ticket 01 owns the publish
 * tick and feeds this registry's snapshot to the same pure aggregator, so
 * there is exactly one aggregation path and one place that writes gauges.
 */
export async function runRtpStatisticsSweep(
  source: ClientLegSource,
): Promise<readonly RtpStatisticsSample[]> {
  const handles = source.listClientLegs().filter(isSweepable);
  const samples = await sweepAll(handles, config.AUDIO_RTP_SWEEP_CONCURRENCY);

  rtpStatisticsRegistry.replace(samples);

  return samples;
}

export function startRtpStatisticsSweeper(source: ClientLegSource): void {
  if (timer) {
    logger.warn("RTP statistics sweeper already running");
    return;
  }

  timer = setInterval(() => {
    // A sweep is async, so unlike ticket 01's synchronous tick it can still be
    // running when the next interval fires. Skipping is the right response:
    // queueing sweeps behind a worker that is already struggling is how a
    // metrics poller turns a slow instance into a dead one.
    if (sweepInFlight) {
      logger.warn("RTP statistics sweep still in flight — skipping this tick");
      return;
    }

    sweepInFlight = true;
    runRtpStatisticsSweep(source)
      .catch((err: unknown) => {
        logger.error({ err }, "RTP statistics sweep failed");
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, config.AUDIO_RTP_SWEEP_INTERVAL_MS);

  logger.info(
    {
      intervalMs: config.AUDIO_RTP_SWEEP_INTERVAL_MS,
      concurrency: config.AUDIO_RTP_SWEEP_CONCURRENCY,
    },
    "RTP statistics sweeper started",
  );
}

export function stopRtpStatisticsSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  sweepInFlight = false;
}
