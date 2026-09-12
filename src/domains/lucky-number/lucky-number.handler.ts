/**
 * luckyNumber:start — Room owner/admin starts a Lucky Number round
 * (lucky-number/01, PRD `docs/issues/lucky-number/prd-lucky-number.md`).
 *
 * GATE: feature flag, sender in room, owner/admin (verifyRoomManager), no
 *       live round, cooldown elapsed, ≥ MIN_SEATS occupied.
 * EXECUTE: create round (server draws the number), arm the per-round timer,
 *          broadcast `luckyNumber:started` to the room INCLUDING sender.
 * Timer (EXECUTE, deferred): `resolveRound` broadcasts `luckyNumber:result`
 *   and clears state — see lucky-number.resolve.ts.
 * Picks (lucky-number/02) live in lucky-number-pick.handler.ts.
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
  type LuckyNumberRound,
} from "./lucky-number.round.js";
import { resolveRound } from "./lucky-number.resolve.js";
import { luckyNumberPickHandler } from "./lucky-number-pick.handler.js";

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
      round = await startRound(context.redis, roomId, (ended) => {
        resolveRound(ended, context).catch((err) =>
          logger.error({ err, roomId, roundId: ended.roundId }, "Lucky Number: resolve failed"),
        );
      });
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

export const luckyNumberHandler = (socket: Socket, context: AppContext) => {
  socket.on("luckyNumber:start", luckyNumberStartHandler(socket, context));
  socket.on("luckyNumber:pick", luckyNumberPickHandler(socket, context));
};
