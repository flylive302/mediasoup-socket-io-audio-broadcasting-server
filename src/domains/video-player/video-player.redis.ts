/**
 * Video Player — Redis keys, atomic Lua scripts, Snapshot reads (room-video-player/02).
 *
 * Two keys per room, both on the DURABLE client (`context.redis`), both TTL 7200 s:
 *   room:{id}:videoPlayer = Controller userId (the mutex)
 *   room:{id}:videoState  = Snapshot JSON (what late joiners and the cascade read)
 *
 * Every check-then-act is ONE Lua script (the recurring MSAB bug shape is a GET,
 * an `await`, then a SET that a rival wrote in between). Unlike music:
 *   - acquire (media-slot.redis.ts, ticket 03 — it also checks the music mutex)
 *     writes the mutex AND the Snapshot in one script, so there is never a mutex
 *     without a Snapshot (or a Snapshot without its holder);
 *   - every Controller write (pause/resume/seek/heartbeat) refreshes BOTH TTLs —
 *     the music heartbeat does not refresh its mutex; do not copy that;
 *   - every write bumps `revision` inside the script, so it is strictly monotonic
 *     across instances. Clients drop any Snapshot whose revision is not newer.
 *
 * Revision on re-`play` (change link mid-video) continues from the stored Snapshot
 * (old + 1) instead of restarting at 1 — otherwise every client would drop the new
 * link as out-of-order. A cleared slot (`stateChanged null`) resets the client's
 * last-seen revision, so a fresh session starting at 1 is accepted.
 *
 * Media-slot exclusivity with music and owner takeover: media-slot.redis.ts (03).
 */
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";

/** Crash backstop: a Controller that dies without a disconnect frees the slot after 2 h. */
export const VIDEO_PLAYER_TTL_SECONDS = 7200;

export const videoPlayerKey = (roomId: string): string => `room:${roomId}:videoPlayer`;
export const videoStateKey = (roomId: string): string => `room:${roomId}:videoState`;

export type VideoSource =
  | { kind: "youtube"; videoId: string }
  | { kind: "url"; url: string; container: "mp4" | "hls" };

/** Server-authoritative playback state. `serverTs` is epoch ms on the MSAB clock. */
export interface VideoSnapshot {
  controllerUserId: number;
  source: VideoSource;
  title?: string;
  durationSec?: number;
  paused: boolean;
  /** Playback position (seconds) at `serverTs`. */
  positionAtTs: number;
  serverTs: number;
  revision: number;
}

/** How a Controller write treats `paused`: set it, clear it, or keep the stored value (seek). */
export type PausedMode = "pause" | "play" | "keep";

/**
 * Controller write: holder check → mutate position/paused → revision+1 → refresh both TTLs.
 *
 * KEYS[1] mutex, KEYS[2] state
 * ARGV[1] my userId, ARGV[2] ttl, ARGV[3] positionAtTs, ARGV[4] serverTs (ms),
 * ARGV[5] paused mode ('pause' | 'play' | 'keep')
 *
 * Returns the stored JSON, or false (→ null) when the caller is not the holder.
 */
const UPDATE_VIDEO_STATE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
local raw = redis.call('GET', KEYS[2])
if not raw then return false end
local s = cjson.decode(raw)
s.positionAtTs = tonumber(ARGV[3])
s.serverTs = tonumber(ARGV[4])
if ARGV[5] == 'pause' then s.paused = true elseif ARGV[5] == 'play' then s.paused = false end
s.revision = (tonumber(s.revision) or 0) + 1
local out = cjson.encode(s)
redis.call('SET', KEYS[2], out, 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return out
`;

/**
 * Release iff the caller holds the slot: delete mutex + Snapshot. Returns 1 / 0.
 * KEYS[1] mutex, KEYS[2] state, ARGV[1] my userId.
 */
const RELEASE_VIDEO_SLOT_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
return 0
`;

/** Controller write; null when the caller does not hold the slot. */
export async function updateVideoState(
  redis: Redis,
  roomId: string,
  userId: number,
  positionAtTs: number,
  serverTs: number,
  pausedMode: PausedMode,
): Promise<VideoSnapshot | null> {
  const out = (await redis.eval(
    UPDATE_VIDEO_STATE_LUA,
    2,
    videoPlayerKey(roomId),
    videoStateKey(roomId),
    String(userId),
    String(VIDEO_PLAYER_TTL_SECONDS),
    String(positionAtTs),
    String(serverTs),
    pausedMode,
  )) as string | null;
  return out ? (JSON.parse(out) as VideoSnapshot) : null;
}

/** True when the caller held the slot and it is now released. */
export async function releaseVideoSlot(
  redis: Redis,
  roomId: string,
  userId: number,
): Promise<boolean> {
  const released = (await redis.eval(
    RELEASE_VIDEO_SLOT_LUA,
    2,
    videoPlayerKey(roomId),
    videoStateKey(roomId),
    String(userId),
  )) as number;
  return released === 1;
}

/**
 * Current Snapshot for `room:join` acks and the cascade origin snapshot.
 * Callers gate on `VIDEO_PLAYER_ENABLED` BEFORE calling (flag off ⇒ no Redis read).
 */
export async function getVideoPlayerState(
  redis: Redis,
  roomId: string,
): Promise<VideoSnapshot | null> {
  const raw = await redis.get(videoStateKey(roomId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VideoSnapshot;
  } catch (err) {
    logger.warn({ roomId, err }, "Unparseable video Snapshot — treating as no video");
    return null;
  }
}
