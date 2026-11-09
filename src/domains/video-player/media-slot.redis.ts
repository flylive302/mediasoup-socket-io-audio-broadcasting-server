/**
 * Media slot — Redis scripts for the room's ONE media slot (room-video-player/03, PRD D1).
 *
 * A room never runs DJ music and a Room Video at the same time. The two mutexes
 * stay where they were — `room:{id}:musicPlayer` (audio-player) and
 * `room:{id}:videoPlayer` (video-player) — and every acquire checks BOTH inside
 * one Lua script: a GET, an `await`, then a SET a rival wrote in between is the
 * recurring MSAB bug shape.
 *
 *   video acquire  — video free-or-mine AND music free-or-mine; my own music is
 *                    released in the same script.
 *   video takeover — (owner) overwrite the video mutex, release any music.
 *   music acquire  — music free-or-mine AND, when the slot rule is on, video
 *                    free-or-mine; my own video is released in the same script.
 *   music takeover — (owner, slot rule on) clear any video right after the music
 *                    SET; a video acquire racing in between sees the owner's music
 *                    and is refused, so no window leaves both held.
 *
 * Steal: every non-forced acquire takes one proven-dead holder per mutex
 * ('' disables) — the CAS shape of the music-dj-queue/01 stale-proof acquire. The
 * caller proves "no live socket in the room" before passing it.
 *
 * The music waiting queue is deliberately untouched: releasing a DJ's music here
 * never pops or grants a waiter (a grantee could not play under a video anyway).
 * Stranded waiters are a follow-up in the epic index, not this slice.
 *
 * Lives in video-player because the slot rule is this epic's; it imports only the
 * two leaf key modules, so neither handler is in its import graph (no cycle).
 */
import type { Redis } from "ioredis";
import {
  musicPlayerKey,
  musicStateKey,
  MUSIC_PLAYER_TTL_SECONDS,
} from "@src/domains/audio-player/audio-player.queue.js";
import {
  videoPlayerKey,
  videoStateKey,
  VIDEO_PLAYER_TTL_SECONDS,
  type VideoSnapshot,
} from "./video-player.redis.js";

export type MediaKind = "music" | "video";

/** Refused: another (live, or not proven dead) user holds one of the two mutexes. */
export interface SlotBusy {
  acquired: false;
  heldBy: MediaKind;
  holder: string;
}

/** Proven-dead holders the next attempt may CAS-steal; '' = none. */
export interface StealSet {
  video: string;
  music: string;
}

export const NO_STEAL: Readonly<StealSet> = { video: "", music: "" };

export type VideoSlotResult =
  | {
      acquired: true;
      snapshot: VideoSnapshot;
      /** Music holder whose mutex this acquire released (me, or a stolen/forced one). */
      releasedMusic: string | null;
      /** Video holder before this acquire (me on a re-play, another user on a steal/takeover). */
      previousVideo: string | null;
    }
  | SlotBusy;

export type MusicSlotResult =
  | {
      acquired: true;
      /** Video Controller whose session this acquire released (me, or a stolen one). */
      releasedVideo: string | null;
    }
  | SlotBusy;

/**
 * Acquire (or re-acquire) the video slot and write the Snapshot.
 *
 * KEYS[1] videoPlayer, KEYS[2] videoState, KEYS[3] musicPlayer, KEYS[4] musicState
 * ARGV[1] me, ARGV[2] steal video holder, ARGV[3] steal music holder, ARGV[4] ttl,
 * ARGV[5] Snapshot JSON (revision set here), ARGV[6] '1' = owner takeover (skip both checks)
 *
 * Returns {'ok', storedJson, releasedMusic|'', previousVideo|''} or {'busy', kind, holder}.
 * Revision continues from the stored Snapshot (old + 1) on re-play, steal and
 * takeover alike — a reset to 1 would be dropped by every client as out-of-order.
 */
const ACQUIRE_VIDEO_SLOT_LUA = `
local v = redis.call('GET', KEYS[1])
local m = redis.call('GET', KEYS[3])
if ARGV[6] ~= '1' then
  if v and v ~= ARGV[1] and not (ARGV[2] ~= '' and v == ARGV[2]) then
    return {'busy', 'video', v}
  end
  if m and m ~= ARGV[1] and not (ARGV[3] ~= '' and m == ARGV[3]) then
    return {'busy', 'music', m}
  end
end
local rev = 0
local raw = redis.call('GET', KEYS[2])
if raw then
  local ok, old = pcall(cjson.decode, raw)
  if ok and type(old) == 'table' then rev = tonumber(old.revision) or 0 end
end
local s = cjson.decode(ARGV[5])
s.revision = rev + 1
local out = cjson.encode(s)
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
redis.call('SET', KEYS[2], out, 'EX', ARGV[4])
if m then redis.call('DEL', KEYS[3], KEYS[4]) end
return {'ok', out, m or '', v or ''}
`;

/**
 * Acquire the music mutex (stale-proof, music-dj-queue/01) with the slot rule.
 *
 * KEYS[1] musicPlayer, KEYS[2] videoPlayer, KEYS[3] videoState
 * ARGV[1] me, ARGV[2] steal music holder, ARGV[3] ttl,
 * ARGV[4] '1' = slot rule on (VIDEO_PLAYER_ENABLED), ARGV[5] steal video holder
 *
 * Returns {'ok', releasedVideo|''} or {'busy', kind, holder}. With ARGV[4] ~= '1'
 * the video keys are never read — byte-for-byte the pre-03 music acquire.
 */
const ACQUIRE_MUSIC_SLOT_LUA = `
local m = redis.call('GET', KEYS[1])
if m and m ~= ARGV[1] and not (ARGV[2] ~= '' and m == ARGV[2]) then
  return {'busy', 'music', m}
end
local v = false
if ARGV[4] == '1' then
  v = redis.call('GET', KEYS[2])
  if v and v ~= ARGV[1] and not (ARGV[5] ~= '' and v == ARGV[5]) then
    return {'busy', 'video', v}
  end
  if v then redis.call('DEL', KEYS[2], KEYS[3]) end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return {'ok', v or ''}
`;

/**
 * Unconditional video release (owner music takeover). Returns the previous
 * Controller or ''. KEYS[1] videoPlayer, KEYS[2] videoState.
 */
const CLEAR_VIDEO_SLOT_LUA = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1], KEYS[2]) end
return v or ''
`;

const orNull = (value: string | undefined): string | null => (value ? value : null);

function busy(reply: string[]): SlotBusy {
  return { acquired: false, heldBy: reply[1] as MediaKind, holder: String(reply[2]) };
}

/**
 * One video acquire attempt. `force` = owner takeover: always acquires,
 * overwriting any Controller and releasing any music.
 */
export async function acquireVideoSlotOnce(
  redis: Redis,
  roomId: string,
  userId: number,
  draft: Omit<VideoSnapshot, "revision">,
  steal: Readonly<StealSet>,
  force = false,
): Promise<VideoSlotResult> {
  const reply = (await redis.eval(
    ACQUIRE_VIDEO_SLOT_LUA,
    4,
    videoPlayerKey(roomId),
    videoStateKey(roomId),
    musicPlayerKey(roomId),
    musicStateKey(roomId),
    String(userId),
    steal.video,
    steal.music,
    String(VIDEO_PLAYER_TTL_SECONDS),
    JSON.stringify({ ...draft, revision: 0 }),
    force ? "1" : "0",
  )) as string[];

  if (reply[0] !== "ok") return busy(reply);
  return {
    acquired: true,
    snapshot: JSON.parse(String(reply[1])) as VideoSnapshot,
    releasedMusic: orNull(reply[2]),
    previousVideo: orNull(reply[3]),
  };
}

/** One music acquire attempt; `slotRule` = VIDEO_PLAYER_ENABLED. */
export async function acquireMusicSlotOnce(
  redis: Redis,
  roomId: string,
  userId: number,
  steal: Readonly<StealSet>,
  slotRule: boolean,
): Promise<MusicSlotResult> {
  const reply = (await redis.eval(
    ACQUIRE_MUSIC_SLOT_LUA,
    3,
    musicPlayerKey(roomId),
    videoPlayerKey(roomId),
    videoStateKey(roomId),
    String(userId),
    steal.music,
    String(MUSIC_PLAYER_TTL_SECONDS),
    slotRule ? "1" : "0",
    steal.video,
  )) as string[];

  if (reply[0] !== "ok") return busy(reply);
  return { acquired: true, releasedVideo: orNull(reply[1]) };
}

/** Release any Room Video regardless of holder; returns the previous Controller or null. */
export async function clearVideoSlot(redis: Redis, roomId: string): Promise<string | null> {
  const previous = (await redis.eval(
    CLEAR_VIDEO_SLOT_LUA,
    2,
    videoPlayerKey(roomId),
    videoStateKey(roomId),
  )) as string;
  return orNull(previous);
}
