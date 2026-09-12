/**
 * Lucky Number Domain — in-room tap-to-guess mini-game (ADR 0015 pattern)
 *
 * MSAB is the round authority: it draws the number, owns the timer, and
 * broadcasts `started` / `result`. Nothing is persisted beyond a short Redis TTL.
 */
export { luckyNumberHandler } from "./lucky-number.handler.js";
export { luckyNumberPickHandler } from "./lucky-number-pick.handler.js";
export { getLiveRound, clearAllLiveRounds } from "./lucky-number.round.js";
export type { LuckyNumberRound } from "./lucky-number.round.js";
