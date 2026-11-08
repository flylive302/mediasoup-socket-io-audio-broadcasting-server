/**
 * Video Player — pure GATE helpers (room-video-player/02). No I/O.
 */
import { Errors } from "@src/shared/errors.js";
import type { VideoSource } from "./video-player.redis.js";

/** Product limit for a direct link (matches the frontend's ROOM_VIDEO_URL_MAX_LENGTH). */
export const VIDEO_URL_MAX_LENGTH = 2048;

/**
 * Semantic rules for a Source. YouTube ids are fully checked by the schema.
 * Direct links: https only, ≤ 2048 chars, parseable. MSAB never fetches the
 * URL (no SSRF surface) — this only stops junk reaching every client.
 */
export function checkVideoSource(source: VideoSource): string | null {
  if (source.kind !== "url") return null;
  if (source.url.length > VIDEO_URL_MAX_LENGTH) return Errors.VIDEO_SOURCE_INVALID;
  try {
    return new URL(source.url).protocol === "https:" ? null : Errors.VIDEO_SOURCE_INVALID;
  } catch {
    return Errors.VIDEO_SOURCE_INVALID;
  }
}
