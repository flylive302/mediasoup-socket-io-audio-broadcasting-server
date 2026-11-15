/**
 * Audio Player Lifecycle Hook (LT-5)
 *
 * Registers disconnect cleanup for the music player domain.
 * Replaces the previously hard-coded clearMusicPlayerOnDisconnect call
 * in socket/index.ts handleDisconnect.
 *
 * room-music-playlist/02: an explicit `room:leave` (and the implicit room switch)
 * releases the leaver's music too — `releaseMusicOnRoomLeave`, called from
 * performRoomLeave. Both exits run the SAME `releaseMusicOnRoomExit`.
 */
import type { Socket } from "socket.io";
import type { DomainLifecycle, DisconnectContext } from "@src/shared/lifecycle.js";
import type { AppContext } from "@src/context.js";
import { reactError } from "@src/shared/react-error.js";
import {
  releaseMusicPlayerForUser,
  userHasLiveSocketInRoom,
} from "./audio-player.handler.js";
import { musicPlayerKey, musicQueueKey } from "./audio-player.queue.js";

export const audioPlayerLifecycle: DomainLifecycle = {
  name: "audio-player",

  async onDisconnect(ctx: DisconnectContext, appCtx: AppContext): Promise<void> {
    if (!ctx.roomId) return;
    await releaseMusicOnRoomExit(appCtx, ctx.roomId, ctx.userId, ctx.socket.id);
  },
};

/**
 * `room:leave` / room switch. Never throws: the leave (or the join that switched
 * rooms) is already done and must not fail on music cleanup; the disconnect hook
 * (which only fires while the socket still has a room) and the 2 h TTL are the
 * backstops. Mirrors `releaseVideoOnRoomLeave`.
 */
export async function releaseMusicOnRoomLeave(
  socket: Socket,
  context: AppContext,
  roomId: string,
): Promise<void> {
  const userId = socket.data.user.id as number;
  try {
    if (!(await hasMusicStakeInRoom(context, roomId, userId))) return;
    await releaseMusicOnRoomExit(context, roomId, userId, socket.id);
  } catch (err) {
    reactError(err, { roomId, userId }, "Music release on room:leave failed");
  }
}

/**
 * Cheap GATE for the leave path: does this user hold the music mutex or sit in the
 * waiting line? Every `room:leave` and room switch runs through here, and most
 * leavers have nothing to do with music — skip the fleet-wide liveness fetch for
 * them. A stake gained after this read (a race with the leave) falls back to the
 * stale-steal acquire and the 2 h TTL, exactly as before this fix.
 */
async function hasMusicStakeInRoom(
  context: AppContext,
  roomId: string,
  userId: number,
): Promise<boolean> {
  const [holder, queuePos] = await Promise.all([
    context.redis.get(musicPlayerKey(roomId)),
    context.redis.lpos(musicQueueKey(roomId), String(userId)),
  ]);
  return holder === String(userId) || queuePos !== null;
}

/**
 * The ONE music cleanup for a user exiting a room — shared by the disconnect hook
 * and `room:leave`. GATE no other live socket of this user in the room → EXECUTE
 * dequeue → release (+ `stopped` broadcast + grant the next waiter). Throws on a
 * Redis failure; the leave wrapper above swallows it, the disconnect path keeps
 * its existing behaviour.
 *
 * music-dj-queue/01: a hard refresh reconnects (possibly on ANOTHER instance
 * behind the LB) and reuses/refreshes the mutex BEFORE this delayed disconnect
 * fires. Disconnect hooks run before clientManager.removeClient, so the exiting
 * socket is excluded by id. If the user still has another live socket in the room,
 * the reused slot must survive — skip the release entirely. Guarded ONLY here;
 * kick/eject/seat-lock/shrink callers of releaseMusicPlayerForUser stay
 * unconditional. On cross-node fetch failure fetchSocketsSafe reads empty →
 * we fall through and release (stale-proof acquisition self-heals a wrong one).
 */
export async function releaseMusicOnRoomExit(
  appCtx: AppContext,
  roomId: string,
  userId: number,
  excludeSocketId: string,
): Promise<void> {
  if (await userHasLiveSocketInRoom(appCtx, userId, roomId, excludeSocketId)) {
    return;
  }

  // music-dj-queue/05: the user is truly gone from the room — dequeue any
  // waiting spot (a queued admin who closed the tab must not stay in line) and
  // do it BEFORE the release, so a dead DJ who was somehow also queued can't be
  // granted the slot to themselves.
  await appCtx.redis.lrem(musicQueueKey(roomId), 0, String(userId));

  await releaseMusicPlayerForUser(
    appCtx.redis,
    appCtx.io,
    roomId,
    userId,
    appCtx.cascadeRelay,
  );
}
