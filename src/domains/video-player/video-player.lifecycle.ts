/**
 * Video Player — release paths (room-video-player/03, PRD D1).
 *
 * The Room Video ends when its Controller is gone from the room:
 *   - disconnect of their LAST live socket in the room  → videoPlayerLifecycle
 *   - explicit `room:leave` and the implicit room switch → releaseVideoOnRoomLeave
 *     (called from performRoomLeave, never from finalizeLeave — that one also runs
 *     on disconnect, which this hook already covers)
 *   - ejection                                           → ejectRoomMember
 *   - room close / orphan reap                           → clearVideoPlayerForRoom
 * NOT on seat lock or seat shrink: the Controller need not be seated.
 *
 * Every path checks VIDEO_PLAYER_ENABLED first, so a flag-off fleet never touches
 * Redis for video (02's inertness promise). Cost of that choice: if the flag is
 * flipped off mid-session, a leftover Snapshot lives until its 2 h TTL — harmless,
 * because with the flag off nothing reads it (join ack, cascade and music acquire
 * all skip the video keys).
 */
import type { Socket } from "socket.io";
import type { Redis } from "ioredis";
import type { AppContext } from "@src/context.js";
import type { DomainLifecycle, DisconnectContext } from "@src/shared/lifecycle.js";
import { config } from "@src/config/index.js";
import { reactError } from "@src/shared/react-error.js";
import { userHasLiveSocketInRoom } from "@src/domains/audio-player/index.js";
import { releaseVideoPlayerForUser } from "./video-player.handler.js";
import { videoPlayerKey, videoStateKey } from "./video-player.redis.js";

export const videoPlayerLifecycle: DomainLifecycle = {
  name: "video-player",

  async onDisconnect(ctx: DisconnectContext, appCtx: AppContext): Promise<void> {
    if (!ctx.roomId) return;
    await releaseIfControllerGone(appCtx, ctx.userId, ctx.roomId, ctx.socket.id);
  },
};

/**
 * `room:leave` / room switch. Never throws: the leave (or the join that switched
 * rooms) is already done and must not fail on video cleanup; the disconnect hook
 * and the 2 h TTL are the backstops.
 */
export async function releaseVideoOnRoomLeave(
  socket: Socket,
  context: AppContext,
  roomId: string,
): Promise<void> {
  const userId = socket.data.user.id as number;
  try {
    await releaseIfControllerGone(context, userId, roomId, socket.id);
  } catch (err) {
    reactError(err, { roomId, userId }, "Room Video release on room:leave failed");
  }
}

/**
 * Room close: drop both keys, no broadcast (`room:closed` already went out).
 * Never rejects — closeRoom awaits its cleanup ops with Promise.all.
 */
export async function clearVideoPlayerForRoom(redis: Redis, roomId: string): Promise<void> {
  if (!config.VIDEO_PLAYER_ENABLED) return;
  try {
    await redis.del(videoPlayerKey(roomId), videoStateKey(roomId));
  } catch (err) {
    reactError(err, { roomId }, "Room Video cleanup on room close failed");
  }
}

/**
 * GATE flag → GATE is-Controller (one cheap GET: almost no leave or disconnect is
 * the Controller's, and the liveness check below may fan out across the fleet) →
 * GATE no other live socket of this user in the room (a hard refresh that
 * reconnected first, or a second tab, keeps the video — prior art: the
 * audio-player trailing-disconnect guard) → EXECUTE release (a holder-checked
 * Lua, so a race with a new acquire can only no-op).
 */
async function releaseIfControllerGone(
  appCtx: AppContext,
  userId: number,
  roomId: string,
  leavingSocketId: string,
): Promise<void> {
  if (!config.VIDEO_PLAYER_ENABLED) return;
  if ((await appCtx.redis.get(videoPlayerKey(roomId))) !== String(userId)) return;
  if (await userHasLiveSocketInRoom(appCtx, userId, roomId, leavingSocketId)) return;
  await releaseVideoPlayerForUser(appCtx.redis, appCtx.io, roomId, userId, appCtx.cascadeRelay);
}
