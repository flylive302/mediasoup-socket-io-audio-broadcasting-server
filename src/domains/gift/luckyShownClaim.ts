/**
 * gift-cashback-latency 08: show-once claim for lucky results — GATE.
 *
 * Laravel delivers each lucky result (`lucky:result`, `lucky:no-draw` to the
 * sender; `lucky:room-result` to the room) through TWO paths for the same win:
 *   (a) inline, in the gift batch HTTP response (giftBuffer.ts), and
 *   (b) queued, as an outbox envelope relayed by event-router.ts.
 * The client double-counts a duplicate, so MSAB shows each one exactly once:
 * whichever path reaches MSAB first wins, the other drops its copy.
 *
 * Key: `msab:lucky:shown:{event}:{reference_id}` — fleet-wide on purpose (NO
 * instance id). MSAB's Redis is shared by the fleet and the two paths can land
 * on different instances; a per-instance key would never see the other copy.
 * `event` is part of the key because one win has three results with the same
 * `reference_id` (sender result, room result) that must not suppress each other.
 *
 * Fails OPEN, same policy as `claimFanoutEmit` (infrastructure/event-dedup.ts):
 * suppress only on positive evidence (SET NX answering `null`, i.e. the key
 * already exists). A Redis error, or a payload with nothing to join on, resolves
 * to `true` — a rare duplicate animation is a far smaller incident than a lost
 * win.
 */
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";
import { RELAY_EVENTS } from "@src/integrations/laravel/types.js";

/**
 * Same horizon as the ingest dedup (event-dedup.ts `DEDUP_TTL_SECONDS`): far
 * past any gap between the inline response and the outbox relay of one win.
 */
export const LUCKY_SHOWN_TTL_SECONDS = 600;

const KEY_PREFIX = "msab:lucky:shown";

/** The three events that carry a lucky result to a client. */
const LUCKY_SHOWN_EVENTS: ReadonlySet<string> = new Set([
  RELAY_EVENTS.lucky.LUCKY_RESULT,
  RELAY_EVENTS.lucky.LUCKY_NO_DRAW,
  RELAY_EVENTS.lucky.LUCKY_ROOM_RESULT,
]);

/** GATE (pure): is this relay event one of the lucky results that show once? */
export function isLuckyShownEvent(event: string): boolean {
  return LUCKY_SHOWN_EVENTS.has(event);
}

/** GATE (pure): the payload's `reference_id`, or null when absent / not a non-empty string. */
function referenceIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const referenceId = (payload as { reference_id?: unknown }).reference_id;
  return typeof referenceId === "string" && referenceId !== "" ? referenceId : null;
}

/**
 * GATE (pure): the claim key for one lucky result, or null when the payload has
 * no usable `reference_id`. Shared by the claim and by a caller that hands the
 * claim back (see event-router.ts), so both always address the same key.
 */
export function buildLuckyShownKey(event: string, payload: unknown): string | null {
  const referenceId = referenceIdOf(payload);
  return referenceId === null ? null : `${KEY_PREFIX}:${event}:${referenceId}`;
}

/**
 * Claim the right to show one lucky result. `true` = this caller emits;
 * `false` = the other path already showed it, drop this copy.
 */
export async function claimLuckyShown(
  redis: Redis,
  event: string,
  payload: unknown,
): Promise<boolean> {
  const key = buildLuckyShownKey(event, payload);
  if (key === null) return true;

  try {
    const result = await redis.set(key, "1", "EX", LUCKY_SHOWN_TTL_SECONDS, "NX");
    return result !== null;
  } catch (error) {
    logger.warn(
      { error, event, key },
      "Lucky shown-once claim failed — emitting anyway (fail open)",
    );
    return true;
  }
}
