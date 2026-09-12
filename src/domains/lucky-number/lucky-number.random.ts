/**
 * Lucky Number — server-authoritative draw seam.
 *
 * The drawn number MUST come from the server (same rule as lucky gifts).
 * Tests swap the generator via `setLuckyNumberRandom` for determinism.
 */
export const LUCKY_NUMBER_MIN = 1;
export const LUCKY_NUMBER_MAX = 9;

type UnitRandom = () => number;

let generator: UnitRandom = Math.random;

/** Test seam — pass a function returning [0, 1). */
export function setLuckyNumberRandom(fn: UnitRandom | null): void {
  generator = fn ?? Math.random;
}

/** Draw an integer in [LUCKY_NUMBER_MIN, LUCKY_NUMBER_MAX]. */
export function drawLuckyNumber(): number {
  const span = LUCKY_NUMBER_MAX - LUCKY_NUMBER_MIN + 1;
  return LUCKY_NUMBER_MIN + Math.floor(generator() * span);
}
