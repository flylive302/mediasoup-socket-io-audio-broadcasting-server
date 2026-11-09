/**
 * Video Player Handler — Room Video, a synced link (room-video-player/02).
 *
 * Every client plays the same link itself; MSAB holds the server-authoritative
 * Snapshot and fans it out. No video ever flows through mediasoup.
 *
 * Every handler checks `VIDEO_PLAYER_ENABLED` FIRST, before any Redis read
 * (verifyRoomManager reads Redis), so a flag-off box is fully inert.
 *
 * Fan-out: one `videoPlayer:stateChanged {roomId, snapshot}` to the whole room
 * (sender included) on play / takeover / pause / resume / seek / stop / ended.
 * The 2 s heartbeat is NOT relayed — clients extrapolate from positionAtTs + elapsed.
 *
 * Media slot (03): play refuses with MEDIA_SLOT_BUSY while another user holds
 * the music or the video; the owner's takeover overwrites both. Whoever is
 * displaced hears it on their own sockets (`audioPlayer:revoked` /
 * `videoPlayer:revoked`). Release paths beyond stop/ended: video-player.lifecycle.ts.
 */
import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import type { AppContext } from "@src/context.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  videoPlayerPlaySchema,
  videoPlayerTakeoverSchema,
  videoPlayerPositionSchema,
  videoPlayerHeartbeatSchema,
  videoPlayerRoomOnlySchema,
} from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { Errors } from "@src/shared/errors.js";
import { verifyRoomManager, verifyRoomOwner } from "@src/domains/seat/seat.owner.js";
import { userHasLiveSocketInRoom } from "@src/domains/audio-player/index.js";
import { checkVideoSource } from "./video-player.gates.js";
import {
  updateVideoState,
  releaseVideoSlot,
  type PausedMode,
  type VideoSnapshot,
  type VideoSource,
} from "./video-player.redis.js";
import { acquireVideoSlotOnce, NO_STEAL, type VideoSlotResult } from "./media-slot.redis.js";
import {
  acquireWithStaleSteal,
  announceMusicStoppedByVideo,
  emitToUserInRoom,
  slotBusyAck,
} from "./media-slot.js";

// ─────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────

/** videoPlayer:play — a room manager starts (or changes) the Room Video. */
const playHandler = createHandler(
  "videoPlayer:play",
  videoPlayerPlaySchema,
  async (payload, socket, context) => {
    const { roomId, source, title, durationSec } = payload;
    const userId = socket.data.user.id;

    if (!config.VIDEO_PLAYER_ENABLED) return { success: false, error: Errors.VIDEO_PLAYER_DISABLED };
    if (!isInRoom(socket, context, roomId)) return { success: false, error: Errors.NOT_IN_ROOM };

    const authorization = await verifyRoomManager(roomId, String(userId), context);
    if (!authorization.allowed) return { success: false, error: authorization.error };

    const sourceError = checkVideoSource(source);
    if (sourceError) return { success: false, error: sourceError };

    const draft = newDraft(userId, source, title, durationSec);
    const result = await acquireWithStaleSteal(
      (steal) => acquireVideoSlotOnce(context.redis, roomId, userId, draft, steal),
      (holder) => userHasLiveSocketInRoom(context, Number(holder), roomId),
    );
    if (!result.acquired) return slotBusyAck(result);

    await announceSlotTaken(context, roomId, userId, result);
    broadcastSnapshot(context.io, roomId, result.snapshot, context.cascadeRelay);
    logger.info({ roomId, userId, kind: source.kind, revision: result.snapshot.revision }, "Room Video started");
    return { success: true };
  },
);

/**
 * videoPlayer:takeover — the room OWNER force-takes the media slot (admins get
 * NOT_AUTHORIZED, the verifyRoomOwner tier). Overwrites any Controller, releases
 * any music, revokes whoever was displaced, then starts the owner's Source.
 */
const takeoverHandler = createHandler(
  "videoPlayer:takeover",
  videoPlayerTakeoverSchema,
  async (payload, socket, context) => {
    const { roomId, source, title, durationSec } = payload;
    const userId = socket.data.user.id;

    if (!config.VIDEO_PLAYER_ENABLED) return { success: false, error: Errors.VIDEO_PLAYER_DISABLED };
    if (!isInRoom(socket, context, roomId)) return { success: false, error: Errors.NOT_IN_ROOM };

    const authorization = await verifyRoomOwner(roomId, String(userId), context);
    if (!authorization.allowed) return { success: false, error: authorization.error };

    const sourceError = checkVideoSource(source);
    if (sourceError) return { success: false, error: sourceError };

    const draft = newDraft(userId, source, title, durationSec);
    const result = await acquireVideoSlotOnce(context.redis, roomId, userId, draft, NO_STEAL, true);
    if (!result.acquired) return slotBusyAck(result); // unreachable: a forced acquire always wins

    await announceSlotTaken(context, roomId, userId, result);
    broadcastSnapshot(context.io, roomId, result.snapshot, context.cascadeRelay);
    logger.info(
      { roomId, userId, displacedVideo: result.previousVideo, releasedMusic: result.releasedMusic },
      "Room Video force-taken by owner",
    );
    return { success: true };
  },
);

const pauseHandler = transportHandler("videoPlayer:pause", "pause");
const resumeHandler = transportHandler("videoPlayer:resume", "play");
// Seek keeps the stored paused state — scrubbing a paused video must not start it for the room.
const seekHandler = transportHandler("videoPlayer:seek", "keep");

/**
 * videoPlayer:heartbeat — Controller-only, every 2 s. Refreshes both TTLs and
 * the Snapshot's position (so late joiners see real playback, buffering
 * included). Never emitted to the room.
 */
const heartbeatHandler = createHandler(
  "videoPlayer:heartbeat",
  videoPlayerHeartbeatSchema,
  async (payload, socket, context) => {
    const { roomId, positionSec, paused } = payload;
    if (!config.VIDEO_PLAYER_ENABLED) return { success: false, error: Errors.VIDEO_PLAYER_DISABLED };

    const mode: PausedMode = paused ? "pause" : "play";
    const snapshot = await updateVideoState(
      context.redis, roomId, socket.data.user.id, positionSec, Date.now(), mode,
    );
    return snapshot ? { success: true } : { success: false, error: Errors.NOT_AUTHORIZED };
  },
);

const stopHandler = releaseHandler("videoPlayer:stop");
const endedHandler = releaseHandler("videoPlayer:ended");

// ─────────────────────────────────────────────────────────────────
// Handler factories
// ─────────────────────────────────────────────────────────────────

/** pause / resume / seek: holder-only write, then fan the new Snapshot out. */
function transportHandler(event: string, mode: PausedMode) {
  return createHandler(event, videoPlayerPositionSchema, async (payload, socket, context) => {
    const { roomId, positionSec } = payload;
    if (!config.VIDEO_PLAYER_ENABLED) return { success: false, error: Errors.VIDEO_PLAYER_DISABLED };
    if (!isInRoom(socket, context, roomId)) return { success: false, error: Errors.NOT_IN_ROOM };

    const snapshot = await updateVideoState(
      context.redis, roomId, socket.data.user.id, positionSec, Date.now(), mode,
    );
    if (!snapshot) return { success: false, error: Errors.NOT_AUTHORIZED };

    broadcastSnapshot(context.io, roomId, snapshot, context.cascadeRelay);
    return { success: true };
  });
}

/** stop / ended: holder-only release, then `stateChanged null` to the room. */
function releaseHandler(event: string) {
  return createHandler(event, videoPlayerRoomOnlySchema, async (payload, socket, context) => {
    if (!config.VIDEO_PLAYER_ENABLED) return { success: false, error: Errors.VIDEO_PLAYER_DISABLED };
    const released = await releaseVideoPlayerForUser(
      context.redis, context.io, payload.roomId, socket.data.user.id, context.cascadeRelay,
    );
    return released ? { success: true } : { success: false, error: Errors.NOT_AUTHORIZED };
  });
}

// ─────────────────────────────────────────────────────────────────
// Stage helpers
// ─────────────────────────────────────────────────────────────────

function isInRoom(socket: Socket, context: AppContext, roomId: string): boolean {
  return context.clientManager.getClient(socket.id)?.roomId === roomId;
}

function newDraft(
  userId: number,
  source: VideoSource,
  title: string | undefined,
  durationSec: number | undefined,
): Omit<VideoSnapshot, "revision"> {
  return {
    controllerUserId: userId,
    source,
    ...(title !== undefined && { title }),
    ...(durationSec !== undefined && { durationSec }),
    paused: false,
    positionAtTs: 0,
    serverTs: Date.now(),
  };
}

/**
 * Tell whoever the acquire displaced, before the new Snapshot goes out: a DJ
 * whose music was released (the starter themself included — see
 * announceMusicStoppedByVideo), and a different previous Controller.
 */
async function announceSlotTaken(
  context: AppContext,
  roomId: string,
  userId: number,
  result: Extract<VideoSlotResult, { acquired: true }>,
): Promise<void> {
  if (result.releasedMusic !== null) {
    await announceMusicStoppedByVideo(
      context.io, context.clientManager, roomId, Number(result.releasedMusic), userId, context.cascadeRelay,
    );
  }
  if (result.previousVideo !== null && result.previousVideo !== String(userId)) {
    await emitToUserInRoom(
      context.io, context.clientManager, Number(result.previousVideo), roomId, "videoPlayer:revoked",
      { roomId, byUserId: userId, reason: "takeover" },
    );
  }
}

function broadcastSnapshot(
  io: Server,
  roomId: string,
  snapshot: VideoSnapshot | null,
  cascadeRelay: CascadeRelay | null,
): void {
  broadcastToRoom(io, roomId, "videoPlayer:stateChanged", { roomId, snapshot }, cascadeRelay);
}

/**
 * Release the Room Video iff `userId` is the Controller, and tell the room.
 * No-op (false) otherwise. Shared by stop / ended, the disconnect and
 * room:leave paths (video-player.lifecycle.ts) and ejection (no socket needed).
 */
export async function releaseVideoPlayerForUser(
  redis: Redis,
  io: Server,
  roomId: string,
  userId: number,
  cascadeRelay: CascadeRelay | null,
): Promise<boolean> {
  const released = await releaseVideoSlot(redis, roomId, userId);
  if (!released) return false;
  broadcastSnapshot(io, roomId, null, cascadeRelay);
  logger.info({ roomId, userId }, "Room Video released");
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Export: register all video player handlers on a socket
// ─────────────────────────────────────────────────────────────────

export const videoPlayerHandler = (socket: Socket, context: AppContext): void => {
  socket.on("videoPlayer:play", playHandler(socket, context));
  socket.on("videoPlayer:takeover", takeoverHandler(socket, context));
  socket.on("videoPlayer:pause", pauseHandler(socket, context));
  socket.on("videoPlayer:resume", resumeHandler(socket, context));
  socket.on("videoPlayer:seek", seekHandler(socket, context));
  socket.on("videoPlayer:heartbeat", heartbeatHandler(socket, context));
  socket.on("videoPlayer:stop", stopHandler(socket, context));
  socket.on("videoPlayer:ended", endedHandler(socket, context));
};
