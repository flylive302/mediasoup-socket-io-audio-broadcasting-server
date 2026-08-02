/**
 * Live client-leg quality store.
 *
 * The SFU pushes a score event whenever a stream's quality changes — already
 * computed, no polling, effectively free. This holds the latest score per live
 * leg so the sampler can take a cheap snapshot on its own interval.
 *
 * Bounded by live capacity: exactly one entry per registered client leg,
 * removed by `scoreObservers` on the leg's mediasoup `observer.on("close")`.
 * That observer fires on EVERY close path — including a bare `producer.close()`
 * with no transport teardown, which `transportclose` misses. A leg that
 * lingered here after closing would keep contributing its last score to `min`
 * and `p01` forever.
 *
 * No mediasoup types here on purpose: this stays trivially testable, and the
 * subscription details live one module over.
 */
import type { QualityDirection, QualitySample } from "./qualityAggregator.js";

export class ScoreRegistry {
  private readonly samples = new Map<string, QualitySample>();

  /** Upsert a leg's latest score. Called from the SFU's score push. */
  record(sample: QualitySample): void {
    this.samples.set(sample.streamId, sample);
  }

  /** Drop a closed leg. Safe to call for an id that was never recorded. */
  forget(streamId: string): void {
    this.samples.delete(streamId);
  }

  /**
   * A copied array, so the pure aggregator can never reach live state.
   */
  snapshot(): QualitySample[] {
    return [...this.samples.values()];
  }

  /** Number of live legs currently reporting. */
  get size(): number {
    return this.samples.size;
  }

  clear(): void {
    this.samples.clear();
  }
}

/** Process-wide registry. One MSAB process serves many rooms. */
export const scoreRegistry = new ScoreRegistry();

/**
 * Identity of the participant a client leg belongs to.
 *
 * Threaded from the socket handlers because neither `RouterManager` nor
 * `RoomMediaCluster` knows the room or the user. Used ONLY for ticket 03's
 * log path — see the cardinality rule in `qualityAggregator.ts`.
 */
export interface ClientLeg {
  readonly roomId: string;
  readonly userId: string;
}

export function buildSample(
  leg: ClientLeg,
  streamId: string,
  direction: QualityDirection,
  score: number,
): QualitySample {
  return {
    streamId,
    direction,
    score,
    roomId: leg.roomId,
    userId: leg.userId,
  };
}
