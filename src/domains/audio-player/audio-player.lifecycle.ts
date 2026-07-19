/**
 * Audio Player Lifecycle Hook (LT-5)
 *
 * Registers disconnect cleanup for the music player domain.
 * Replaces the previously hard-coded clearMusicPlayerOnDisconnect call
 * in socket/index.ts handleDisconnect.
 */
import type { DomainLifecycle, DisconnectContext } from "@src/shared/lifecycle.js";
import type { AppContext } from "@src/context.js";
import {
  releaseMusicPlayerForUser,
  userHasLiveSocketInRoom,
} from "./audio-player.handler.js";

export const audioPlayerLifecycle: DomainLifecycle = {
  name: "audio-player",

  async onDisconnect(ctx: DisconnectContext, appCtx: AppContext): Promise<void> {
    if (!ctx.roomId) return;

    // music-dj-queue/01: a hard refresh reconnects (possibly on ANOTHER instance
    // behind the LB) and reuses/refreshes the mutex BEFORE this delayed disconnect
    // fires. Lifecycle hooks run before clientManager.removeClient, so exclude the
    // dying socket by id. If the user still has another live socket in the room,
    // the reused slot must survive — skip the release entirely. Guarded ONLY here;
    // kick/eject/seat-lock/shrink callers of releaseMusicPlayerForUser stay
    // unconditional. On cross-node fetch failure fetchSocketsSafe reads empty →
    // we fall through and release (stale-proof acquisition self-heals a wrong one).
    if (await userHasLiveSocketInRoom(appCtx, ctx.userId, ctx.roomId, ctx.socket.id)) {
      return;
    }

    await releaseMusicPlayerForUser(
      appCtx.redis,
      appCtx.io,
      ctx.roomId,
      ctx.userId,
      appCtx.cascadeRelay,
    );
  },
};
