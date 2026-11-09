/**
 * Video Player Domain — Room Video, watched together (room-video-player).
 *
 * A synced link, never a stream: MSAB holds the Snapshot (who controls, which
 * Source, paused, position at a server timestamp) and every client plays the
 * link locally. Ships inert behind VIDEO_PLAYER_ENABLED.
 */
export { videoPlayerHandler, releaseVideoPlayerForUser } from "./video-player.handler.js";
export { getVideoPlayerState, type VideoSnapshot } from "./video-player.redis.js";
export {
  videoPlayerLifecycle,
  releaseVideoOnRoomLeave,
  clearVideoPlayerForRoom,
} from "./video-player.lifecycle.js";
