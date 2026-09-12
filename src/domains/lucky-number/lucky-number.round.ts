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
/** Hash userId → picked number. Shared across cascade instances (lucky-number/02). */
export const luckyNumberPicksKey = (roomId: string) =>
  `room:${roomId}:luckyNumber:picks`;

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

/**
 * Read the Redis mirror of the live round (another instance of a cascaded
 * room may own the timer). `null` when there is no round or Redis fails.
 */
export async function readRoundMirror(
  redis: Redis,
  roomId: string,
): Promise<LuckyNumberRound | null> {
  try {
    const raw = await redis.get(luckyNumberRoundKey(roomId));
    return raw ? (JSON.parse(raw) as LuckyNumberRound) : null;
  } catch {
    return null;
  }
}

export type RecordPickOutcome = "ok" | "round-over";

/**
 * Record (or overwrite) a user's pick. The Redis hash is the shared source of
 * truth read at `endsAt`; the in-memory copy on the owning instance is a
 * fallback if that read fails. Throws if Redis refuses the write.
 */
export async function recordPick(
  redis: Redis,
  round: LuckyNumberRound,
  userId: string,
  number: number,
  now: number = Date.now(),
): Promise<RecordPickOutcome> {
  if (now >= round.endsAt) return "round-over";

  const local = liveRounds.get(round.roomId);
  if (local && local.round.roundId === round.roundId) {
    local.round.picks[userId] = number;
  }

  await redis
    .multi()
    .hset(luckyNumberPicksKey(round.roomId), userId, String(number))
    .pexpire(luckyNumberPicksKey(round.roomId), Math.max(1, round.endsAt - now) + ROUND_TTL_GRACE_MS)
    .exec();
  return "ok";
}

/**
 * Picks as they stand at resolve time: the shared Redis hash, merged over the
 * in-memory picks (local wins only when Redis is unreachable).
 */
export async function collectPicks(
  redis: Redis,
  round: LuckyNumberRound,
): Promise<Record<string, number>> {
  const picks: Record<string, number> = { ...round.picks };
  try {
    const shared = await redis.hgetall(luckyNumberPicksKey(round.roomId));
    for (const [userId, value] of Object.entries(shared)) {
      const n = Number(value);
      if (Number.isInteger(n)) picks[userId] = n;
    }
  } catch {
    // Fall through with the local copy.
  }
  return picks;
}

/** What a late joiner / reconnecting client needs to render a live round (lucky-number/03). */
export interface LuckyNumberSnapshot {
  roundId: string;
  endsAt: number;
  /** userIds (string form) that have locked in a pick — numbers stay hidden. */
  pickedUserIds: string[];
}

/**
 * Live-round snapshot for the join ack. Reads Redis (not memory) so every
 * instance of a cascaded room answers the same. `null` when no round is live,
 * when the mirror has already expired, or when Redis fails — the joiner then
 * simply sees no round, which is the safe default.
 */
export async function readSnapshot(
  redis: Redis,
  roomId: string,
  now: number = Date.now(),
): Promise<LuckyNumberSnapshot | null> {
  const round = await readRoundMirror(redis, roomId);
  if (!round || now >= round.endsAt) return null;
  let pickedUserIds: string[] = Object.keys(round.picks);
  try {
    pickedUserIds = await redis.hkeys(luckyNumberPicksKey(roomId));
  } catch {
    // Fall through with the mirror's copy.
  }
  return { roundId: round.roundId, endsAt: round.endsAt, pickedUserIds };
}

/**
 * Drop a user's pick because they left their Seat mid-round — a vacated Seat
 * can never win. Cheap no-op when no round is live on this instance AND no
 * picks hash exists. Never throws: the caller is a seat-vacate REACT step.
 */
export async function dropPick(redis: Redis, roomId: string, userId: string): Promise<void> {
  const local = liveRounds.get(roomId);
  if (local) delete local.round.picks[userId];
  try {
    await redis.hdel(luckyNumberPicksKey(roomId), userId);
  } catch {
    // Redis unreachable — the resolve-time seat filter is the safety net.
  }
}

/**
 * Room closed mid-round: disarm the timer and drop every key WITHOUT a
 * result broadcast or cooldown (nobody is left to receive either). Never throws.
 */
export async function cancelRound(redis: Redis, roomId: string): Promise<void> {
  const local = liveRounds.get(roomId);
  if (local) {
    clearTimeout(local.timer);
    liveRounds.delete(roomId);
  }
  try {
    await redis.del(luckyNumberRoundKey(roomId), luckyNumberPicksKey(roomId));
  } catch {
    // TTL covers the leftover mirror.
  }
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
  const pipeline = redis
    .multi()
    .del(luckyNumberRoundKey(roomId))
    .del(luckyNumberPicksKey(roomId));
  if (config.LUCKY_NUMBER_COOLDOWN_MS > 0) {
    pipeline.set(luckyNumberCooldownKey(roomId), "1", "PX", config.LUCKY_NUMBER_COOLDOWN_MS);
  }
  await pipeline.exec();
}
