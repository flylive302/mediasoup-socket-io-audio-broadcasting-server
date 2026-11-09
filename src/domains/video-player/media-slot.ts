/**
 * Media slot — acquire orchestration and displacement announcements shared by
 * the music and video handlers (room-video-player/03). Scripts: media-slot.redis.ts.
 *
 * Import graph stays acyclic: this file depends on shared/ helpers and the
 * video-player redis modules only — never on either handler.
 */
import type { Server } from "socket.io";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import type { ClientManager } from "@src/client/clientManager.js";
import { logger } from "@src/infrastructure/logger.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { fetchSocketsSafe } from "@src/shared/fetch-sockets-safe.js";
import { Errors } from "@src/shared/errors.js";
import type { HandlerResult } from "@src/shared/handler.utils.js";
import type { SlotBusy, StealSet } from "./media-slot.redis.js";

/**
 * Stale-proof acquire across both mutexes. Try free-or-mine; on a denial, steal
 * only a holder with no live socket in the room anywhere in the fleet, via a
 * CAS that loses to any rival who got there first. Each mutex is stolen at most
 * once, so this makes at most three attempts; a denial on a mutex already
 * stolen means a rival won the CAS — reported busy, never retried.
 */
export async function acquireWithStaleSteal<T extends { acquired: true }>(
  attempt: (steal: Readonly<StealSet>) => Promise<T | SlotBusy>,
  holderIsLive: (holder: string) => Promise<boolean>,
): Promise<T | SlotBusy> {
  const steal: StealSet = { video: "", music: "" };
  let result = await attempt(steal);
  for (let tries = 1; tries < 3 && !result.acquired; tries++) {
    if (steal[result.heldBy] !== "") break;
    if (await holderIsLive(result.holder)) break;
    steal[result.heldBy] = result.holder;
    result = await attempt(steal);
  }
  return result;
}

/** `MEDIA_SLOT_BUSY` ack — details inside `data`, the shape 02 shipped. */
export function slotBusyAck(busy: SlotBusy): HandlerResult {
  return {
    success: false,
    error: Errors.MEDIA_SLOT_BUSY,
    data: { heldBy: busy.heldBy, userId: Number(busy.holder) },
  };
}

/**
 * Targeted emit to every socket `userId` holds in `roomId`, fleet-wide: the
 * local clientManager ids plus the redis adapter's view (`fetchSocketsSafe`
 * falls back to local-only on a cross-node failure). `io.to(socketIds)` routes
 * socket-id rooms across instances. No socket anywhere → no-op.
 */
export async function emitToUserInRoom(
  io: Server,
  clientManager: ClientManager | undefined,
  userId: number,
  roomId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const ids = new Set(clientManager?.getSocketIdsByUserInRoom(userId, roomId) ?? []);
  for (const s of await fetchSocketsSafe(io, roomId, logger)) {
    if (Number(s.data?.user?.id) === userId) ids.add(s.id);
  }
  if (ids.size > 0) io.to([...ids]).emit(event, payload);
}

/**
 * A video took the slot from music: the room sees music `stopped`, and the DJ's
 * own sockets get `audioPlayer:revoked {reason:'video'}` — even when the DJ is
 * the one who started the video. The frontend ignores `stateChanged` events
 * about itself, so `revoked` is the only signal that tears down the DJ's music
 * producer; without it their track keeps streaming under the video.
 */
export async function announceMusicStoppedByVideo(
  io: Server,
  clientManager: ClientManager | undefined,
  roomId: string,
  djUserId: number,
  byUserId: number,
  cascadeRelay: CascadeRelay | null,
): Promise<void> {
  broadcastToRoom(
    io,
    roomId,
    "audioPlayer:stateChanged",
    { state: "stopped", userId: djUserId, title: null, duration: 0, position: 0 },
    cascadeRelay,
  );
  await emitToUserInRoom(io, clientManager, djUserId, roomId, "audioPlayer:revoked", {
    roomId,
    byUserId,
    reason: "video",
  });
  logger.info({ roomId, djUserId, byUserId }, "Music stopped — the Room Video took the media slot");
}

/**
 * Music took the slot from a Room Video: the room gets `stateChanged null`; a
 * displaced Controller (not the DJ themself) also gets `videoPlayer:revoked`.
 */
export async function announceVideoStoppedByMusic(
  io: Server,
  clientManager: ClientManager | undefined,
  roomId: string,
  controllerUserId: number,
  byUserId: number,
  cascadeRelay: CascadeRelay | null,
): Promise<void> {
  broadcastToRoom(io, roomId, "videoPlayer:stateChanged", { roomId, snapshot: null }, cascadeRelay);
  if (controllerUserId !== byUserId) {
    await emitToUserInRoom(io, clientManager, controllerUserId, roomId, "videoPlayer:revoked", {
      roomId,
      byUserId,
      reason: "music",
    });
  }
  logger.info({ roomId, controllerUserId, byUserId }, "Room Video stopped — music took the media slot");
}
