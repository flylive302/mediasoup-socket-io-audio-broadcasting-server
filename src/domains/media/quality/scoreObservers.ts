/**
 * REACT: subscribe a client leg's SFU score pushes into the score registry.
 *
 * Attached from `RouterManager.registerConsumer` / `registerProducer` — the
 * single point where client legs are already registered. There is no new
 * registration path, and every subscription is torn down by the leg's own
 * `observer.on("close")`.
 *
 * ONLY client legs reach these functions. `RouterManager` calls them solely
 * when the caller passed an explicit `ClientLeg`, which the two relay
 * registration sites (`api/internal.ts` reverse-pipe finalize and
 * `cascade/edge-pipe-lifecycle.ts` forward-pipe) do not — so relay legs are
 * excluded by default-deny rather than by sniffing `appData`. The edge
 * forward-pipe producer carries no `appData` at all, so a sniffing check
 * could not have told it apart from a client producer that forgot to set one.
 *
 * ⚠️ PAUSED LEGS ARE EXCLUDED, and this is load-bearing rather than tidy.
 * Mute is a normal steady state in a seat-based audio room, and every
 * listener consumer is created `paused: true` (`roomMediaCluster.ts`) before
 * being resumed. A paused leg carries no audio, so whatever score it reports
 * is not a measure of anyone's experience — and if the SFU reports a low one
 * for an idle stream, mute alone would pin `min` and `p01` near zero and
 * drown the exact low tail these metrics exist to watch. A paused leg is
 * dropped from the registry and re-recorded on resume from the SFU's own
 * score getter, so it does not have to wait for the next score change to
 * reappear.
 */
import type * as mediasoup from "mediasoup";
import { buildSample, scoreRegistry, type ClientLeg } from "./scoreRegistry.js";

/**
 * A participant being served audio.
 *
 * `ConsumerScore.score` is this leg's own RTP quality; `producerScore` is the
 * upstream speaker's and is deliberately NOT recorded here — publishing it
 * under `receiving` would double-count the sending leg, which reports itself.
 *
 * A consumer is inaudible when either end is paused, so `producerPaused`
 * counts the same as `paused`.
 */
export function observeConsumerQuality(
  consumer: mediasoup.types.Consumer,
  leg: ClientLeg,
): void {
  const forget = () => scoreRegistry.forget(consumer.id);

  const record = (score: number): void => {
    if (!Number.isFinite(score)) return;
    if (consumer.paused || consumer.producerPaused) {
      forget();
      return;
    }
    scoreRegistry.record(buildSample(leg, consumer.id, "receiving", score));
  };

  // The SFU pushes on change — already computed, no polling.
  consumer.on("score", (score) => record(score.score));

  // On resume, take the current score straight from the SFU rather than
  // waiting for it to change again.
  const refresh = () => record(consumer.score.score);
  consumer.observer.on("resume", refresh);
  consumer.on("producerresume", refresh);

  consumer.observer.on("pause", forget);
  consumer.on("producerpause", forget);
  consumer.observer.on("close", forget);
}

/**
 * A participant's microphone or music stream. The producer score event
 * carries an ARRAY — one entry per RTP encoding — unlike the consumer event's
 * single object. Audio is never simulcast here, so entry 0 is the stream.
 *
 * An empty array is SKIPPED, never defaulted to 0: zero is worst-possible
 * quality and a synthetic one would dominate `min` and `p01`.
 */
export function observeProducerQuality(
  producer: mediasoup.types.Producer,
  leg: ClientLeg,
): void {
  const forget = () => scoreRegistry.forget(producer.id);

  const record = (scores: readonly mediasoup.types.ProducerScore[]): void => {
    const first = scores[0];
    if (!first || !Number.isFinite(first.score)) return;
    if (producer.paused) {
      forget();
      return;
    }
    scoreRegistry.record(buildSample(leg, producer.id, "sending", first.score));
  };

  producer.on("score", record);
  producer.observer.on("resume", () => record(producer.score));

  producer.observer.on("pause", forget);
  producer.observer.on("close", forget);
}
