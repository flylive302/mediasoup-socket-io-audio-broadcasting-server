/**
 * Event Ordering Guards — GATE for order-sensitive Laravel → MSAB events.
 *
 * Deduplication (event-dedup.ts) removes *identical* redeliveries. It cannot
 * help with **reordering**: the delivery job retries with `[2, 10, 30]`s
 * backoff, so a failed earlier event can land after a successful later one.
 * Three event classes apply state unconditionally and so reach the wrong
 * terminal state when that happens:
 *
 *   - `room.updated`         — a stale copy re-shrinks seats and evicts occupants
 *   - `room.member_removed` /
 *     `room.user_unblocked`  — unconditional SET/DEL of the block mirror
 *   - `auth.revoke_tokens`   — unconditional SET, a replay undoing a newer revocation
 *
 * Each guard below is last-write-wins on an explicit version, applied
 * atomically in Redis so two concurrent deliveries cannot interleave a
 * read-then-write.
 *
 * `eval` rather than `defineCommand`: these fire on moderation and settings
 * events, not on the hot media path, so the per-call script upload is
 * irrelevant — and it keeps the call site free of registration lifecycle.
 * Same choice the audio-player queue makes.
 */
import type { Redis } from "ioredis";

/**
 * How long a version marker outlives its event.
 *
 * Must exceed the reordering window it defends against — the delivery job's
 * three attempts with `[2, 10, 30]`s backoff ≈ 42s. Kept equal to the dedup
 * TTL so both windows expire together and there is one number to reason about.
 *
 * After it lapses, ordering is unguarded again: a genuinely newer event is then
 * indistinguishable from a very late replay. That is the correct trade — an
 * event arriving 10 minutes late is far more likely to be real than a replay,
 * and exact replays are already dead at the dedup gate.
 */
export const VERSION_TTL_SECONDS = 600;

/**
 * Namespace note: see the key-namespace proof in `event-dedup.ts`. Laravel
 * prefixes every key it writes with `backend-database-`, and the only bare
 * `msab:` key MSAB writes is `msab:revocation_poll:since` — `msab:ver:` is
 * unused on both sides.
 */
const VERSION_PREFIX = "msab:ver";

/** Version marker for a room's settings (seat count) sync. */
export const ROOM_UPDATED_VERSION_KEY = (roomId: string) =>
  `${VERSION_PREFIX}:room-updated:${roomId}`;

/**
 * Version marker shared by block AND unblock for one (room, user) pair.
 *
 * It must be a SEPARATE key from the block mirror itself. `deleteBlock` removes
 * the mirror outright, so without an external marker a stale block landing
 * after an unblock would simply recreate it. And the marker cannot live in the
 * mirror key because `RoomBlockRepository.getStatus` reads that key's TTL as
 * the block state (-2 absent / -1 permanent / >0 remaining) — a tombstone
 * stored there would read back as "blocked".
 */
export const ROOM_BLOCK_VERSION_KEY = (roomId: string, userId: number) =>
  `${VERSION_PREFIX}:room-block:${roomId}:${userId}`;

/**
 * Accept-if-not-older, atomically.
 *
 * Rejects only a **strictly older** version; ties are accepted. Laravel stamps
 * `now()->toIso8601String()`, which is second-precision, so two legitimate
 * updates inside the same second carry the same version — dropping on a tie
 * would discard real updates. A tie can only be two *distinct* events (exact
 * duplicates already died at the dedup gate), and applying both is correct.
 *
 * FAILS OPEN: a Redis error resolves to `true`. Skipping the guard restores
 * today's unguarded behaviour for that one event; failing closed would silently
 * stop applying blocks and settings changes during a Redis blip.
 */
const ACCEPT_IF_NOT_OLDER = `
  local current = redis.call('GET', KEYS[1])
  local incoming = tonumber(ARGV[1])
  if current then
    local stored = tonumber(current)
    if stored and stored > incoming then
      return 0
    end
  end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
`;

export async function acceptIfNotOlder(
  redis: Redis,
  versionKey: string,
  versionMs: number,
  ttlSeconds: number = VERSION_TTL_SECONDS,
): Promise<boolean> {
  try {
    const accepted = await redis.eval(
      ACCEPT_IF_NOT_OLDER,
      1,
      versionKey,
      String(versionMs),
      String(ttlSeconds),
    );
    return accepted === 1;
  } catch {
    return true;
  }
}

/**
 * Write a revocation watermark only when it is strictly newer than the stored
 * one, atomically.
 *
 * `auth.revoke_tokens` needs no side-car version key: `payload.revoked_at` IS
 * the version, sender-authoritative and monotonic, and it is already the value
 * being stored. `>=` rather than `>` makes an exact replay a true no-op instead
 * of silently extending the key's TTL.
 *
 * `tonumber(current)` is nil-guarded so a legacy or corrupted non-numeric value
 * is overwritten rather than raising a Lua error.
 *
 * FAILS OPEN, same reasoning as `acceptIfNotOlder` — a revocation that does not
 * get written is a user who stays logged in, so a Redis blip must not turn the
 * guard into a silent drop.
 */
const WRITE_IF_NEWER = `
  local current = redis.call('GET', KEYS[1])
  local incoming = tonumber(ARGV[1])
  if current then
    local stored = tonumber(current)
    if stored and stored >= incoming then
      return 0
    end
  end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
`;

export async function writeIfNewer(
  redis: Redis,
  key: string,
  value: number,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const written = await redis.eval(
      WRITE_IF_NEWER,
      1,
      key,
      String(value),
      String(ttlSeconds),
    );
    return written === 1;
  } catch {
    return true;
  }
}

/**
 * The version an event carries, in epoch milliseconds — or `null` when it has
 * none and every ordering guard must be skipped.
 *
 * `timestamp` is optional on the wire. It used to be zod-defaulted to the
 * receiver's arrival time, which is *worse than absent* here: arrival time
 * reflects the reordering rather than the intent, so a replay would look
 * newest and win. Absent must therefore mean "no guard", never "now".
 */
export function eventVersionMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}
