/**
 * Audio Player Domain — Room music playback coordination
 *
 * Manages per-room music player mutex and metadata broadcasting.
 * The audio stream itself flows through existing mediasoup producers.
 */
export { audioPlayerHandler } from "./audio-player.handler.js";
export { clearMusicPlayerOnDisconnect, getMusicPlayerState } from "./audio-player.handler.js";
