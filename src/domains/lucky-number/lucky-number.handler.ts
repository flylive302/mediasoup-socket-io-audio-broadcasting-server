/**
 * luckyNumber:start — Room owner/admin starts a Lucky Number round
 * (lucky-number/01, PRD `docs/issues/lucky-number/prd-lucky-number.md`).
 *
 * GATE: feature flag, sender in room, owner/admin (verifyRoomManager), no
 *       live round, cooldown elapsed, ≥ MIN_SEATS occupied.
 * EXECUTE: create round (server draws the number), arm the per-round timer,
 *          broadcast `luckyNumber:started` to the room INCLUDING sender.
 * Timer (EXECUTE, deferred): broadcast `luckyNumber:result`, clear state.
 * REACT: none — nothing persisted, nothing buffered.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { luckyNumberStartSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import {
  getLiveRound,
  isCoolingDown,
  startRound,
  finishRound,
  type LuckyNumberRound,
} from "./lucky-number.round.js";

export const luckyNumberStartHandler = createHandler(
  "luckyNumber:start",
  luckyNumberStartSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId } = payload;

    // GATE — feature flag (ships off; flipped per environment)
    if (!config.LUCKY_NUMBER_ENABLED) {
      return { success: false, error: Errors.LUCKY_NUMBER_DISABLED };
    }

    // GATE — sender must be a room participant
    if (!socket.rooms.has(roomId)) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // GATE — owner or admin
    const auth = await verifyRoomManager(roomId, userId, context);
    if (!auth.allowed) {
      return { success: false, error: auth.error };
    }

    // GATE — one round at a time (fast local check; the Redis NX claim in
    // startRound is the cross-instance authority)
    if (getLiveRound(roomId)) {
      return { success: false, error: Errors.LUCKY_NUMBER_ROUND_LIVE };
    }

    // GATE — cooldown since the last round
    if (await isCoolingDown(context.redis, roomId)) {
      return { success: false, error: Errors.LUCKY_NUMBER_COOLDOWN };
    }

    // GATE — enough seated players
    const occupied = await context.seatRepository.countOccupiedSeats(roomId);
    if (occupied < config.LUCKY_NUMBER_MIN_SEATS) {
      return { success: false, error: Errors.LUCKY_NUMBER_NOT_ENOUGH_SEATS };
    }

    // EXECUTE — create state + timer. Redis refusal = round refused.
    let round: LuckyNumberRound | null;
    try {
      round = await startRound(context.redis, roomId, (ended) =>
        endRound(ended, context),
      );
    } catch (err) {
      logger.error({ err, roomId, userId }, "Lucky Number: failed to persist round");
      return { success: false, error: Errors.LUCKY_NUMBER_STATE_UNAVAILABLE };
    }
    if (!round) {
      // Another instance of this room claimed the round first.
      return { success: false, error: Errors.LUCKY_NUMBER_ROUND_LIVE };
    }

    broadcastToRoom(
      socket.nsp,
      roomId,
      "luckyNumber:started",
      { roundId: round.roundId, endsAt: round.endsAt },
      context.cascadeRelay,
    );

    logger.info(
      { roomId, userId, roundId: round.roundId, endsAt: round.endsAt },
      "Lucky Number round started",
    );

    return { success: true, data: { roundId: round.roundId, endsAt: round.endsAt } };
  },
);

/**
 * Timer callback — the one place a round resolves. Winners are the seated
 * users whose pick equals `drawn` (nobody can pick yet in ticket 01, so this
 * is always empty until ticket 02 lands the pick handler).
 */
function endRound(round: LuckyNumberRound, context: AppContext): void {
  const winners = Object.entries(round.picks)
    .filter(([, pick]) => pick === round.drawn)
    .map(([userId]) => userId);

  broadcastToRoom(
    context.io,
    round.roomId,
    "luckyNumber:result",
    {
      roundId: round.roundId,
      drawn: round.drawn,
      picks: round.picks,
      winners,
      // Server-authoritative cooldown so the FE button window matches the gate.
      cooldownMs: config.LUCKY_NUMBER_COOLDOWN_MS,
    },
    context.cascadeRelay,
  );

  finishRound(context.redis, round.roomId).catch((err) =>
    logger.warn({ err, roomId: round.roomId }, "Lucky Number: cleanup failed"),
  );

  logger.info(
    { roomId: round.roomId, roundId: round.roundId, drawn: round.drawn, winners },
    "Lucky Number round resolved",
  );
}

export const luckyNumberHandler = (socket: Socket, context: AppContext) => {
  socket.on("luckyNumber:start", luckyNumberStartHandler(socket, context));
};
