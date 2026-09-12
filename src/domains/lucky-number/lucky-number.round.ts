/**
 * Lucky Number — round state (lucky-number/01).
 *
 * One live round per room. Authoritative copy is in-memory on the instance
 * that started it (it owns the single `setTimeout`); a JSON mirror lives in
 * Redis with a TTL slightly longer than the round so late joiners and other
 * cascade instances can read it (ticket 03). Cooldown is a Redis key whose
 * TTL *is* the cooldown — no clock math, survives an instance swap.
 *
 * Data access only. No socket emits here — the handler owns EXECUTE.
 */
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { config } from "@src/config/index.js";
import { drawLuckyNumber } from "./lucky-number.random.js";

export interface LuckyNumberRound {
  roundId: string;
  roomId: string;
  startedAt: number;
  endsAt: number;
  picks: Record<string, number>;
  /** Hidden from clients until `luckyNumber:result`. */
  drawn: number;
}

export const luckyNumberRoundKey = (roomId: string) =>
  `room:${roomId}:luckyNumber`;
export const luckyNumberCooldownKey = (roomId: string) =>
  `room:${roomId}:luckyNumber:cooldown`;

/** Redis mirror outlives the round by this much so `result` readers never miss it. */
const ROUND_TTL_GRACE_MS = 5_000;

interface LiveRound {
  round: LuckyNumberRound;
  timer: NodeJS.Timeout;
}

const liveRounds = new Map<string, LiveRound>();

export function getLiveRound(roomId: string): LuckyNumberRound | null {
  return liveRounds.get(roomId)?.round ?? null;
}

/** Test/lifecycle helper — clears every timer without broadcasting. */
export function clearAllLiveRounds(): void {
  for (const { timer } of liveRounds.values()) clearTimeout(timer);
  liveRounds.clear();
}

export async function isCoolingDown(redis: Redis, roomId: string): Promise<boolean> {
  return (await redis.exists(luckyNumberCooldownKey(roomId))) === 1;
}

/**
 * Build + persist a new round and arm its timer. `onEnd` runs exactly once at
 * `endsAt` with the round as it stands then; state is removed before it runs.
 *
 * The Redis write is an atomic `NX` claim, so two instances of a cascaded
 * room cannot both start a round: the loser gets `null` and must refuse.
 * Throws if Redis is unreachable — the caller must refuse the start
 * (never degrade to memory-only state).
 */
export async function startRound(
  redis: Redis,
  roomId: string,
  onEnd: (round: LuckyNumberRound) => void,
  now: number = Date.now(),
): Promise<LuckyNumberRound | null> {
  const round: LuckyNumberRound = {
    roundId: randomUUID(),
    roomId,
    startedAt: now,
    endsAt: now + config.LUCKY_NUMBER_ROUND_MS,
    picks: {},
    drawn: drawLuckyNumber(),
  };

  const claimed = await redis.set(
    luckyNumberRoundKey(roomId),
    JSON.stringify(round),
    "PX",
    config.LUCKY_NUMBER_ROUND_MS + ROUND_TTL_GRACE_MS,
    "NX",
  );
  if (claimed !== "OK") return null;

  const timer = setTimeout(() => {
    liveRounds.delete(roomId);
    onEnd(round);
  }, config.LUCKY_NUMBER_ROUND_MS);
  timer.unref?.();

  liveRounds.set(roomId, { round, timer });
  return round;
}

/** Remove the Redis mirror and arm the cooldown. Best-effort; caller logs. */
export async function finishRound(redis: Redis, roomId: string): Promise<void> {
  const pipeline = redis.multi().del(luckyNumberRoundKey(roomId));
  if (config.LUCKY_NUMBER_COOLDOWN_MS > 0) {
    pipeline.set(luckyNumberCooldownKey(roomId), "1", "PX", config.LUCKY_NUMBER_COOLDOWN_MS);
  }
  await pipeline.exec();
}
