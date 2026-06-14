/**
 * Active app-scope slides registry (data access).
 *
 * App-scope slides broadcast to every live room (never the lobby). A user who
 * joins a room *after* the broadcast fired would otherwise miss it, so each
 * app-scope `slide:play` is recorded here for a short replay window and handed
 * to late joiners in their `room:join` response (mirrors how `musicPlayer` state
 * rides the join response). Room-scope slides are never stored — they only ever
 * target the single room they were emitted to.
 *
 * Backed by one Redis sorted set scored by expiry timestamp: every read prunes
 * expired members, and the key self-expires so nothing lingers. Uses the shared
 * Redis client, so a join landing on a different instance than the broadcast
 * still sees the active slides (same client the room music mutex coordinates on).
 */
import type { Redis } from "ioredis";

/**
 * How long a fired app slide stays replayable to joiners. The wire payload
 * carries no duration (the slide plays for its SVGA's natural length, unknown
 * server-side), so this is a heuristic window: long enough that a quick re-join
 * still catches a slide that is plausibly still on screen, short enough that
 * stale slides never replay. Kept in step with the client slide-queue staleness.
 */
const REPLAY_WINDOW_MS = 10_000;

/** Cap slides replayed to a single joiner so a burst never floods a late join. */
const MAX_REPLAY = 5;

const KEY = "slide:app:active";

interface StoredSlide {
  /** The resolved `slide:play` payload, replayed verbatim. */
  p: unknown;
  /** Nonce so genuinely-distinct slides never collide as identical ZSET members. */
  n: string;
}

export class ActiveAppSlidesRepository {
  constructor(private readonly redis: Redis) {}

  /** REACT — record an app-scope slide as active for the replay window. */
  async record(payload: unknown, now: number = Date.now()): Promise<void> {
    const member: StoredSlide = {
      p: payload,
      n: `${now}:${Math.random().toString(36).slice(2)}`,
    };
    await this.redis.zadd(KEY, now + REPLAY_WINDOW_MS, JSON.stringify(member));
    // Prune anything already past its window, then bound the key's lifetime.
    await this.redis.zremrangebyscore(KEY, "-inf", now);
    await this.redis.pexpire(KEY, REPLAY_WINDOW_MS);
  }

  /** Currently-active app slides, newest first, capped to MAX_REPLAY. */
  async getActive(now: number = Date.now()): Promise<unknown[]> {
    await this.redis.zremrangebyscore(KEY, "-inf", now);
    const members = await this.redis.zrevrange(KEY, 0, MAX_REPLAY - 1);

    const slides: unknown[] = [];
    for (const raw of members) {
      try {
        slides.push((JSON.parse(raw) as StoredSlide).p);
      } catch {
        // Skip a corrupt member rather than fail the whole join.
      }
    }
    return slides;
  }
}
