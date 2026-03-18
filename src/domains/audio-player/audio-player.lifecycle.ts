/**
 * Audio Player Lifecycle Hook (LT-5)
 *
 * Registers disconnect cleanup for the music player domain.
 * Replaces the previously hard-coded clearMusicPlayerOnDisconnect call
 * in socket/index.ts handleDisconnect.
 */
import type { DomainLifecycle, DisconnectContext } from "@src/shared/lifecycle.js";
import type { AppContext } from "@src/context.js";
import { clearMusicPlayerOnDisconnect } from "./audio-player.handler.js";

export const audioPlayerLifecycle: DomainLifecycle = {
  name: "audio-player",

  async onDisconnect(ctx: DisconnectContext, appCtx: AppContext): Promise<void> {
    if (!ctx.roomId) return;

    await clearMusicPlayerOnDisconnect(
      appCtx.redis,
      appCtx.io,
      ctx.roomId,
      ctx.userId,
      appCtx.cascadeRelay,
    );
  },
};
