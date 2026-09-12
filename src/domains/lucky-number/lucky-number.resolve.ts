/**
 * Lucky Number — round resolution (EXECUTE, deferred to the round timer).
 *
 * The one place a round resolves: gather picks, compute winners, broadcast
 * `luckyNumber:result`, clear state + arm the cooldown. Called by the timer
 * armed in `startRound`; never by a socket handler directly.
 */
import type { AppContext } from "@src/context.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  collectPicks,
  finishRound,
  type LuckyNumberRound,
} from "./lucky-number.round.js";

/** Winners = every user whose pick equals the drawn number. */
export function computeWinners(
  picks: Record<string, number>,
  drawn: number,
): string[] {
  return Object.entries(picks)
    .filter(([, pick]) => pick === drawn)
    .map(([userId]) => userId);
}

/**
 * Safety net for lucky-number/03: keep only picks whose user is STILL seated.
 * The seat-vacate paths already `dropPick`; this covers a dropped Redis write
 * or a vacate that raced the timer. On a seat-read failure the pick is kept
 * (never punish a player for our outage).
 */
async function keepSeatedPicks(
  picks: Record<string, number>,
  roomId: string,
  context: AppContext,
): Promise<Record<string, number>> {
  const kept: Record<string, number> = {};
  await Promise.all(
    Object.entries(picks).map(async ([userId, pick]) => {
      let seated = true;
      try {
        seated = (await context.seatRepository.getUserSeat(roomId, userId)) !== null;
      } catch {
        seated = true;
      }
      if (seated) kept[userId] = pick;
    }),
  );
  return kept;
}

export async function resolveRound(
  round: LuckyNumberRound,
  context: AppContext,
): Promise<void> {
  const picks = await keepSeatedPicks(
    await collectPicks(context.redis, round),
    round.roomId,
    context,
  );
  const winners = computeWinners(picks, round.drawn);

  broadcastToRoom(
    context.io,
    round.roomId,
    "luckyNumber:result",
    {
      roundId: round.roundId,
      drawn: round.drawn,
      picks,
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
