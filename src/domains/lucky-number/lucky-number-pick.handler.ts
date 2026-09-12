/**
 * luckyNumber:pick — a seated user locks in a guess (lucky-number/02).
 *
 * GATE: feature flag, sender in room, sender occupies a Seat, the named round
 *       is live (memory, else the Redis mirror for cascaded rooms), not past
 *       `endsAt`, integer 1–9 (schema), sliding-window rate limit.
 * EXECUTE: record the pick (later overwrites earlier), broadcast
 *          `luckyNumber:picked {roundId, userId}` — NEVER the number.
 * REACT: none.
 */
import type { AppContext } from "@src/context.js";
import { luckyNumberPickSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";
import {
  getLiveRound,
  readRoundMirror,
  recordPick,
  type LuckyNumberRound,
  type RecordPickOutcome,
} from "./lucky-number.round.js";

export const luckyNumberPickHandler = createHandler(
  "luckyNumber:pick",
  luckyNumberPickSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, roundId, number } = payload;

    // GATE — feature flag
    if (!config.LUCKY_NUMBER_ENABLED) {
      return { success: false, error: Errors.LUCKY_NUMBER_DISABLED };
    }

    // GATE — sender must be a room participant
    if (!socket.rooms.has(roomId)) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // GATE — only Speakers (seated users) play
    const seatIndex = await context.seatRepository.getUserSeat(roomId, userId);
    if (seatIndex === null) {
      return { success: false, error: Errors.NOT_SEATED };
    }

    // GATE — the named round must be the live one
    const round = await findRound(context, roomId);
    if (!round || round.roundId !== roundId) {
      return { success: false, error: Errors.LUCKY_NUMBER_NO_ROUND };
    }
    if (Date.now() >= round.endsAt) {
      return { success: false, error: Errors.LUCKY_NUMBER_ROUND_OVER };
    }

    // GATE — rate limit (~1 per 300 ms per sender per room)
    const allowed = await context.rateLimiter.isAllowed(
      `luckyNumber:pick:${userId}:${roomId}`,
      config.RATE_LIMIT_LUCKY_NUMBER_PICKS_PER_WINDOW,
      config.RATE_LIMIT_LUCKY_NUMBER_PICKS_WINDOW_SECONDS,
    );
    if (!allowed) {
      return { success: false, error: Errors.RATE_LIMITED };
    }

    // EXECUTE — record, then tell the room WHO picked (not what)
    let outcome: RecordPickOutcome;
    try {
      outcome = await recordPick(context.redis, round, userId, number);
    } catch (err) {
      logger.error({ err, roomId, userId, roundId }, "Lucky Number: failed to persist pick");
      return { success: false, error: Errors.LUCKY_NUMBER_STATE_UNAVAILABLE };
    }
    if (outcome === "round-over") {
      return { success: false, error: Errors.LUCKY_NUMBER_ROUND_OVER };
    }

    broadcastToRoom(
      socket.nsp,
      roomId,
      "luckyNumber:picked",
      { roundId, userId: socket.data.user.id },
      context.cascadeRelay,
    );

    logger.debug({ roomId, userId, roundId }, "Lucky Number pick recorded");

    return { success: true };
  },
);

/** Live round on this instance, else the Redis mirror (cascaded rooms). */
async function findRound(
  context: AppContext,
  roomId: string,
): Promise<LuckyNumberRound | null> {
  return getLiveRound(roomId) ?? (await readRoundMirror(context.redis, roomId));
}
