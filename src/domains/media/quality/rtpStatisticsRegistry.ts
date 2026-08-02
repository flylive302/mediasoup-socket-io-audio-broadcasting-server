/**
 * The most recent deep-statistics sweep — store, nothing else.
 *
 * Deliberately NOT shaped like `ScoreRegistry`. That one is fed by per-leg
 * push events, so it needs per-leg `record` / `forget` and a close handler on
 * every leg to stay honest. This one is fed by a sweep that enumerates the
 * WHOLE live set every time, so it is replaced wholesale: a leg that closed
 * between sweeps simply is not in the next enumeration and vanishes on its
 * own. There is no lifecycle to get wrong, and no way for a dead leg to keep
 * contributing to a percentile.
 *
 * Held between sweeps on purpose. The sweep interval is independent of — and
 * longer than — the publish interval, so every publish tick republishes the
 * last sweep's numbers rather than dropping the series for the ticks in
 * between.
 */
import type { RtpStatisticsSample } from "./qualityAggregator.js";

export class RtpStatisticsRegistry {
  private samples: readonly RtpStatisticsSample[] = [];

  /** Replace everything with one sweep's results. */
  replace(samples: readonly RtpStatisticsSample[]): void {
    this.samples = [...samples];
  }

  /** The last sweep's results. Already immutable — replaced, never mutated. */
  snapshot(): readonly RtpStatisticsSample[] {
    return this.samples;
  }

  /** Legs the last sweep successfully read. */
  get size(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }
}

/** Process-wide. One MSAB process serves many rooms. */
export const rtpStatisticsRegistry = new RtpStatisticsRegistry();
