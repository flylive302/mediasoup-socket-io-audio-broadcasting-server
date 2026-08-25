/**
 * User XP overlay — keeps wealth_xp / charm_xp fresh across reconnects.
 *
 * Why: `socket.data.user` is hydrated from the MSAB JWT, whose XP claims are a
 * snapshot taken at mint time (up to 24 h old, cached client-side). Every
 * reconnect re-derived the user from that stale token, so other participants
 * saw XP as of last login — usually rendering as "level 1".
 *
 * Fix: every `balance.updated` push from Laravel (the only XP write path)
 * persists the latest XP in Redis; the auth middleware overlays it on the
 * JWT-derived user at connect time. Redis always reflects the most recent
 * DB change, so it wins over the token snapshot. Fail-open: any Redis error
 * leaves the JWT values untouched.
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { User } from "@src/auth/types.js";
import { recordRedisDegradation } from "@src/shared/redis-degradation.js";

const USER_XP_KEY = (userId: number) => `user:${userId}:xp`;

/** Outlives the longest MSAB JWT (24 h) so a stale token can never win. */
const USER_XP_TTL_SECONDS = 72 * 60 * 60;

export type UserXp = { wealth_xp: string; charm_xp: string };

/** GATE — pick numeric-string XP fields out of an untrusted payload. */
export function extractXp(payload: Record<string, unknown>): UserXp | null {
  const w = payload.wealth_xp;
  const c = payload.charm_xp;
  if (typeof w !== "string" || typeof c !== "string") return null;
  if (Number.isNaN(Number(w)) || Number.isNaN(Number(c))) return null;
  return { wealth_xp: w, charm_xp: c };
}

/** EXECUTE — persist the latest XP so reconnects don't revert to the JWT snapshot. */
export async function persistUserXp(
  redis: Redis,
  logger: Logger,
  userId: number,
  xp: UserXp,
): Promise<void> {
  try {
    const key = USER_XP_KEY(userId);
    await redis
      .multi()
      .hset(key, { wealth_xp: xp.wealth_xp, charm_xp: xp.charm_xp })
      .expire(key, USER_XP_TTL_SECONDS)
      .exec();
  } catch (err) {
    recordRedisDegradation("user-xp", "write");
    logger.warn({ err, userId }, "Failed to persist user XP");
  }
}

/**
 * EXECUTE — overlay persisted XP on a JWT-derived user. Returns the same object
 * (untouched) when nothing is persisted or Redis fails.
 */
export async function overlayUserXp(
  redis: Redis,
  logger: Logger,
  user: User,
): Promise<User> {
  try {
    const stored = await redis.hgetall(USER_XP_KEY(user.id));
    const xp = extractXp(stored ?? {});
    if (!xp) return user;
    return { ...user, ...xp };
  } catch (err) {
    recordRedisDegradation("user-xp", "read");
    logger.warn({ err, userId: user.id }, "Failed to overlay user XP");
    return user;
  }
}
