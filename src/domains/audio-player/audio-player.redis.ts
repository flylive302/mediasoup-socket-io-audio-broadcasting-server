/**
 * Audio Player — playback-progress write (room-music-playlist/03).
 *
 * `audioPlayer:stateUpdate` used to be GET holder → GET state → SETEX in three
 * round trips: a stop / takeover / video start landing between the reads and the
 * SETEX let the write resurrect a `musicState` with no holder (phantom "now
 * playing" for late joiners) or overwrite a fresh owner's state. The holder check,
 * the mutex refresh and the state write are now ONE script, the same shape as the
 * Room Video heartbeat (video-player.redis.ts UPDATE_VIDEO_STATE_LUA).
 *
 * Leaf module: depends only on the key helpers in ./audio-player.queue.ts.
 */
import type { Redis } from "ioredis";
import { musicPlayerKey, musicStateKey, MUSIC_PLAYER_TTL_SECONDS } from "./audio-player.queue.js";

/**
 * Holder-checked progress write.
 *
 * KEYS[1]=musicPlayer, KEYS[2]=musicState;
 * ARGV[1]=my userId, ARGV[2]=ttl, ARGV[3]=position (seconds), ARGV[4]='1' paused / '0' playing.
 *
 * Returns 0 when the caller is not the holder (nothing is written, nothing is
 * refreshed — the same NOT_AUTHORIZED as before). Otherwise refreshes the mutex
 * TTL (a continuous session longer than the 2 h backstop keeps its mutex — the
 * old handler never did), then, ONLY if `musicState` still exists, rewrites
 * `position` + `isPaused` in place and refreshes its TTL. A missing state is never
 * created: only play / takeover write a whole state. An unparseable state is left
 * alone. Returns 1.
 *
 * cjson round-trip: musicState holds scalars only (userId, title, duration,
 * startedAt, isPaused, position) — no empty-table `{}` vs `[]` hazard, the 13-digit
 * epoch-ms `startedAt` is inside cjson's 14 significant digits, and a long-float
 * `duration`/`position` loses only digits past the 14th.
 */
const UPDATE_MUSIC_STATE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
local raw = redis.call('GET', KEYS[2])
if raw then
  local ok, s = pcall(cjson.decode, raw)
  if ok and type(s) == 'table' then
    local pos = tonumber(ARGV[3])
    if pos then s.position = pos end
    s.isPaused = (ARGV[4] == '1')
    redis.call('SET', KEYS[2], cjson.encode(s), 'EX', ARGV[2])
  end
end
return 1
`;

/**
 * Apply one progress tick from the music holder. Returns true when the caller
 * holds the mutex (authorized), false when they do not (nothing written).
 */
export async function updateMusicPlaybackState(
  redis: Redis,
  roomId: string,
  userId: number,
  position: number,
  isPaused: boolean,
): Promise<boolean> {
  const result = (await redis.eval(
    UPDATE_MUSIC_STATE_LUA,
    2,
    musicPlayerKey(roomId),
    musicStateKey(roomId),
    String(userId),
    String(MUSIC_PLAYER_TTL_SECONDS),
    String(position),
    isPaused ? "1" : "0",
  )) as number;
  return result === 1;
}
