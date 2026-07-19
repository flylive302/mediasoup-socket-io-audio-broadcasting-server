/**
 * Audio Player Queue — DJ waiting-queue machinery (music-dj-queue/04 + /05)
 *
 * The per-room FIFO of waiting userIds that sits alongside the music mutex, plus
 * the atomic Lua that pops/grants it and the grant-emission helpers. Extracted
 * from audio-player.handler.ts (ticket 05) so the handler file stays under the
 * size budget. Self-contained: it depends only on io/redis/logger, never on the
 * handler, so the import graph stays acyclic (lifecycle → handler → queue).
 */
import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import { fetchSocketsSafe } from "@src/shared/fetch-sockets-safe.js";

// ─────────────────────────────────────────────────────────────────
// Redis key helpers + TTLs (shared with the handler)
// ─────────────────────────────────────────────────────────────────

export const musicPlayerKey = (roomId: string) => `room:${roomId}:musicPlayer`;
export const musicStateKey = (roomId: string) => `room:${roomId}:musicState`;
// music-dj-queue/04: per-room FIFO of waiting userIds (RPUSH tail, LPOP head).
export const musicQueueKey = (roomId: string) => `room:${roomId}:musicQueue`;

// B-5 FIX: TTL for music player keys — safety net if server crashes without cleanup
export const MUSIC_PLAYER_TTL_SECONDS = 7200; // 2 hours

// music-dj-queue/04: grace window for a provisional grant hold. A released slot
// is SET to the queue head for this long; the head's client must play within it
// (their play re-SETs to the full TTL via reuse-if-mine). ticket 05 arms a timer
// at (grace+1)s so a silent grantee's expired hold advances the queue instead of
// stalling it, and ghost-skip drains dead heads without waiting the grace out.
export const MUSIC_GRANT_GRACE_TTL_SECONDS = 15;

// ─────────────────────────────────────────────────────────────────
// Queue Lua (atomic, one round-trip each)
// ─────────────────────────────────────────────────────────────────

/**
 * music-dj-queue/04: enqueue a waiter (idempotent, per user).
 *
 * KEYS[1]=musicQueue; ARGV[1]=userId, ARGV[2]=ttl. If the user is already in the
 * list (`LPOS` finds them) → refresh the TTL and return their existing 1-based
 * position (never a duplicate). Else RPUSH to the tail, refresh the TTL, and
 * return `LLEN` (the new tail's 1-based position). One round-trip keeps the
 * position stable under a re-press while already queued.
 */
const ENQUEUE_MUSIC_WAITER_LUA = `
local pos = redis.call('LPOS', KEYS[1], ARGV[1])
if pos then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return pos + 1
end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('LLEN', KEYS[1])
`;

/**
 * music-dj-queue/04: release the slot and grant it to the queue head — atomically.
 *
 * KEYS[1]=musicPlayer, KEYS[2]=musicState, KEYS[3]=musicQueue;
 * ARGV[1]=releasingUserId, ARGV[2]=graceTtl.
 * If the caller is not the current holder → {'denied', cur or ''} (strict no-op,
 * exactly today's NOT_AUTHORIZED). Else clear the state, LPOP the head, and either
 * SET the slot to that head with the provisional grace TTL or DEL the slot when
 * the queue is empty; return {'released', head or ''}.
 *
 * Rationale: DEL-then-separately-grant would let a third admin's `play` win the
 * freed slot and then be clobbered by the grant — compare, pop, and set must be
 * one round-trip so no other acquire can interleave.
 */
const RELEASE_AND_GRANT_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur ~= ARGV[1] then
  return {'denied', cur or ''}
end
redis.call('DEL', KEYS[2])
local head = redis.call('LPOP', KEYS[3])
if head then
  redis.call('SET', KEYS[1], head, 'EX', ARGV[2])
else
  redis.call('DEL', KEYS[1])
end
return {'released', head or ''}
`;

/**
 * music-dj-queue/04: promote the queue head iff the slot is currently free.
 *
 * KEYS[1]=musicPlayer, KEYS[2]=musicQueue; ARGV[1]=graceTtl. If the slot exists →
 * return '' (someone holds it, nothing to do). Else LPOP the head and, if any,
 * SET the slot to them with the provisional grace TTL; return the head or ''.
 *
 * Rationale: closes the few-ms race where the holder releases BETWEEN a play
 * denial and the enqueue that follows it — without this the enqueuer would be
 * stranded in a queue that nobody will ever pop. ticket 05 also fires it from the
 * grace timer: a played grantee holds the slot (EXISTS → no-op), a silent one's
 * hold has expired (free → pop the next waiter).
 */
const PROMOTE_IF_FREE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return ''
end
local head = redis.call('LPOP', KEYS[2])
if head then
  redis.call('SET', KEYS[1], head, 'EX', ARGV[1])
end
return head or ''
`;

// ─────────────────────────────────────────────────────────────────
// Queue operations
// ─────────────────────────────────────────────────────────────────

/**
 * music-dj-queue/04: enqueue `userId` behind the live DJ, idempotently. Returns
 * their 1-based position (existing if already queued, else the new tail's).
 */
export async function enqueueMusicWaiter(
  redis: Redis,
  roomId: string,
  userId: number,
): Promise<number> {
  return (await redis.eval(
    ENQUEUE_MUSIC_WAITER_LUA,
    1,
    musicQueueKey(roomId),
    String(userId),
    String(MUSIC_PLAYER_TTL_SECONDS),
  )) as number;
}

/**
 * music-dj-queue/04: release the slot held by `userId` and pop+grant the head in
 * one round-trip. Returns ['denied', currentHolder] when `userId` is not the
 * holder, else ['released', headUserId | ''].
 */
export async function releaseAndGrant(
  redis: Redis,
  roomId: string,
  userId: string,
): Promise<[string, string]> {
  return (await redis.eval(
    RELEASE_AND_GRANT_LUA,
    3,
    musicPlayerKey(roomId),
    musicStateKey(roomId),
    musicQueueKey(roomId),
    userId,
    String(MUSIC_GRANT_GRACE_TTL_SECONDS),
  )) as [string, string];
}

/**
 * music-dj-queue/04: promote the queue head only if the slot is free (provisional
 * grace-TTL SET). Returns the promoted head's userId, or '' if the slot is held
 * or the queue is empty.
 */
export async function promoteIfFree(
  redis: Redis,
  roomId: string,
): Promise<string> {
  return (await redis.eval(
    PROMOTE_IF_FREE_LUA,
    2,
    musicPlayerKey(roomId),
    musicQueueKey(roomId),
    String(MUSIC_GRANT_GRACE_TTL_SECONDS),
  )) as string;
}

// ─────────────────────────────────────────────────────────────────
// Liveness + grant emission
// ─────────────────────────────────────────────────────────────────

/**
 * music-dj-queue/01 semantics, io-first: does `userId` still have a live socket
 * in `roomId` (optionally excluding one socket id)? The clientManager local hit
 * is an authoritative fast-path but a local miss is not (the user may sit on
 * another MSAB instance behind the LB), so a miss consults the redis adapter via
 * `fetchSocketsSafe` (bounded, ghost-tolerant, empty on cross-node failure).
 *
 * Lives here so both grant paths can share it: the full-context handlers pass
 * clientManager; the signature-constrained release path passes none (fetch-only,
 * still complete because fetchSocketsSafe includes local sockets).
 */
export async function hasLiveSocketInRoom(
  io: Server,
  clientManager: AppContext["clientManager"] | undefined,
  userId: number,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const local = clientManager?.getSocketIdsByUserInRoom(userId, roomId) ?? [];
  if (local.some((id) => id !== excludeSocketId)) return true;

  const sockets = await fetchSocketsSafe(io, roomId, logger);
  return sockets.some(
    (s) => s.id !== excludeSocketId && Number(s.data?.user?.id) === userId,
  );
}

/**
 * music-dj-queue/04: targeted `audioPlayer:granted` to the grantee's room-scoped
 * sockets, FLEET-WIDE. Local fast-path via clientManager (when available), else
 * the redis adapter via fetchSocketsSafe filtered by user id — `io.to(socketIds)`
 * routes socket-id rooms across instances. If no socket is found anywhere, log
 * and no-op: the grace timer / ghost-skip drains the slot regardless.
 */
export async function grantMusicSlotToUser(
  io: Server,
  roomId: string,
  grantedUserId: string,
  clientManager?: AppContext["clientManager"],
): Promise<void> {
  const uid = Number(grantedUserId);

  let socketIds = clientManager?.getSocketIdsByUserInRoom(uid, roomId) ?? [];
  if (socketIds.length === 0) {
    const sockets = await fetchSocketsSafe(io, roomId, logger);
    socketIds = sockets
      .filter((s) => Number(s.data?.user?.id) === uid)
      .map((s) => s.id);
  }

  if (socketIds.length === 0) {
    logger.info(
      { roomId, grantedUserId },
      "Music slot granted but grantee has no live socket — ghost-skip advances the queue",
    );
    return;
  }

  io.to(socketIds).emit("audioPlayer:granted", { roomId });
}

/**
 * music-dj-queue/05: grant the slot to the first LIVE head, skipping ghosts.
 *
 * `head` is the current provisional holder (a release/promote just SET it). If it
 * has a live socket in the room → emit the grant and arm the grace timer, done.
 * Else the dead head's provisional hold is released atomically (`releaseAndGrant`
 * pops the next waiter in the same round-trip) and the walk continues. A 'denied'
 * result means someone else legitimately took the freed slot mid-walk (a rival
 * acquire or an owner takeover) — stop, their play owns the slot now.
 *
 * This also covers "waiter left the room but stayed connected": they have no
 * socket IN the room → skipped. It is the correctness backstop for every cancel
 * path — a stale queue entry is drained the moment it would be granted.
 *
 * clientManager is optional: the release path (no context) relies on the
 * fetchSocketsSafe fallback inside {@link hasLiveSocketInRoom}, which is complete.
 */
export async function grantChain(
  io: Server,
  redis: Redis,
  roomId: string,
  head: string,
  clientManager?: AppContext["clientManager"],
): Promise<void> {
  let current: string | null = head;
  while (current) {
    if (await hasLiveSocketInRoom(io, clientManager, Number(current), roomId)) {
      await grantMusicSlotToUser(io, roomId, current, clientManager);
      armGraceTimer(io, redis, roomId);
      return;
    }
    const [status, next] = await releaseAndGrant(redis, roomId, current);
    if (status === "denied") return;
    current = next || null;
  }
}

/**
 * music-dj-queue/05: schedule a one-shot promote-if-free just past the grace
 * window. If the grantee played, their play refreshed the mutex to the full TTL
 * → `promoteIfFree` sees EXISTS → no-op. If they stayed silent, the 15s
 * provisional key EXPIREd → the next waiter is popped and granted. If another
 * admin grabbed the freed slot meanwhile → EXISTS → no-op. No keyspace
 * notifications and no holder inspection needed; the mutex state answers it.
 *
 * `.unref()` so a pending timer never holds the process open. Fire-and-forget
 * (REACT): errors are logged, never surfaced. Multiple timers per room are safe —
 * each is an idempotent promote-if-free — so no bookkeeping is kept.
 */
export function armGraceTimer(io: Server, redis: Redis, roomId: string): void {
  setTimeout(() => {
    promoteIfFree(redis, roomId)
      .then((promoted) => (promoted ? grantChain(io, redis, roomId, promoted) : undefined))
      .catch((err) => logger.error({ err, roomId }, "Music grace-timer advance failed"));
  }, (MUSIC_GRANT_GRACE_TTL_SECONDS + 1) * 1000).unref();
}
