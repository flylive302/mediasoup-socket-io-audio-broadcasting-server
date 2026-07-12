/**
 * Shared producer-cleanup helper — dj-talk-over/02.
 *
 * Kick, seat-lock, and shrink-eviction all remove a user from a seat/Room
 * server-side and must close EVERY producer that user holds (mic AND music),
 * not just their voice — otherwise a DJ's music (or a lingering mic) keeps
 * flowing after they've been displaced. This factors out the mic-only close
 * loop that used to be duplicated across those three call sites (dj-talk-over/01).
 *
 * F-45 ownership guard preserved per-producer: a rapid disconnect→reconnect→
 * produce (or mute/unmute) can replace a tracked producer id before this runs;
 * skip closing a producer that no longer belongs to the target user instead of
 * closing a brand-new, unrelated producer.
 */
import type * as mediasoup from "mediasoup";
import { logger } from "@src/infrastructure/logger.js";

export interface ProducerOwnerClient {
  producers: Map<string, string>;
  isSpeaker: boolean;
}

export interface ProducerRoomLike {
  getProducer(producerId: string): mediasoup.types.Producer | undefined;
}

/**
 * EXECUTE-adjacent cleanup: close all of `userId`'s tracked producers on
 * `roomId` (mic + music + any future source), verifying ownership per-producer
 * before closing, then clear the client's producer map and recompute
 * `isSpeaker`. Never throws — a missing room/producer is a no-op, and an
 * ownership mismatch is logged and skipped.
 */
export function closeAllUserProducers(
  client: ProducerOwnerClient,
  userId: number,
  roomId: string,
  room: ProducerRoomLike | undefined,
  logContext: Record<string, unknown> = {},
): void {
  if (client.producers.size === 0) return;

  for (const [source, producerId] of [...client.producers.entries()]) {
    const producer = room?.getProducer(producerId);
    if (producer && !producer.closed) {
      if (producer.appData.userId === userId) {
        producer.close();
        logger.info(
          { ...logContext, roomId, userId, source, producerId },
          "Producer closed on removal",
        );
      } else {
        logger.warn(
          {
            ...logContext,
            roomId,
            userId,
            source,
            producerId,
            producerUserId: producer.appData.userId,
          },
          "Skipped producer close on removal — producer no longer owned by target user (F-45)",
        );
      }
    }
    client.producers.delete(source);
  }

  client.isSpeaker = client.producers.size > 0;
}
