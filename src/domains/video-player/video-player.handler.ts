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
 * (sender included) on play / pause / resume / seek / stop / ended. The 2 s
 * heartbeat is NOT relayed — clients extrapolate from positionAtTs + elapsed.
 */
import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import type { AppContext } from "@src/context.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  videoPlayerPlaySchema,
  videoPlayerPositionSchema,
  videoPlayerHeartbeatSchema,
  videoPlayerRoomOnlySchema,
} from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { Errors } from "@src/shared/errors.js";
import { verifyRoomManager } from "@src/domains/seat/seat.owner.js";
import { userHasLiveSocketInRoom } from "@src/domains/audio-player/index.js";
import { checkVideoSource } from "./video-player.gates.js";
import {
  acquireVideoSlotOnce,
  updateVideoState,
  releaseVideoSlot,
  type PausedMode,
  type VideoSnapshot,
} from "./video-player.redis.js";

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

    const draft: Omit<VideoSnapshot, "revision"> = {
      controllerUserId: userId,
      source,
      ...(title !== undefined && { title }),
      ...(durationSec !== undefined && { durationSec }),
      paused: false,
      positionAtTs: 0,
      serverTs: Date.now(),
    };
    const result = await acquireVideoSlot(context, roomId, userId, draft);
    if (!result.acquired) {
      return {
        success: false,
        error: Errors.MEDIA_SLOT_BUSY,
        data: { heldBy: "video", userId: Number(result.holder) },
      };
    }

    broadcastSnapshot(context.io, roomId, result.snapshot, context.cascadeRelay);
    logger.info({ roomId, userId, kind: source.kind, revision: result.snapshot.revision }, "Room Video started");
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

/**
 * Stale-proof acquire (same shape as the music slot): free-or-mine first; on a
 * denial, steal only when the holder has no live socket in the room anywhere in
 * the fleet, via a CAS that loses to any rival who got there first.
 */
async function acquireVideoSlot(
  context: AppContext,
  roomId: string,
  userId: number,
  draft: Omit<VideoSnapshot, "revision">,
) {
  const first = await acquireVideoSlotOnce(context.redis, roomId, userId, "", draft);
  if (first.acquired) return first;
  if (await userHasLiveSocketInRoom(context, Number(first.holder), roomId)) return first;
  return acquireVideoSlotOnce(context.redis, roomId, userId, first.holder, draft);
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
 * No-op (false) otherwise. Shared by stop / ended now; ticket 03's disconnect,
 * room:leave, ejection and room-close paths call it too (no socket needed).
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
  socket.on("videoPlayer:pause", pauseHandler(socket, context));
  socket.on("videoPlayer:resume", resumeHandler(socket, context));
  socket.on("videoPlayer:seek", seekHandler(socket, context));
  socket.on("videoPlayer:heartbeat", heartbeatHandler(socket, context));
  socket.on("videoPlayer:stop", stopHandler(socket, context));
  socket.on("videoPlayer:ended", endedHandler(socket, context));
};
