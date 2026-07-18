/**
 * DM Typing Indicator — ephemeral client→MSAB→peer relay.
 *
 * dm-realtime-platform/04: migrates the typing indicator off the Reverb
 * client whisper. No persistence, no Laravel involvement — this is a pure
 * transient signal for the whole lifecycle (GATE→EXECUTE; nothing to REACT
 * with, so REACT is a no-op).
 *
 * Delivery scoping: a socket joins a per-(threadId, own userId) Socket.IO
 * room when it opens a DM thread, and leaves it when the thread closes.
 * Socket.IO auto-leaves all rooms on disconnect, so no explicit lifecycle
 * hook is needed for cleanup. `dm:typing` relays only into the peer's
 * (threadId, peerUserId) room via `socket.to(...)`, which — thanks to the
 * existing Redis adapter (src/infrastructure/server.ts) — delivers across
 * MSAB instances automatically, the same mechanism every other room-scoped
 * emit in this codebase already relies on. No new cross-instance
 * infrastructure required.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { config } from "@src/config/index.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { Errors } from "@src/shared/errors.js";
import {
  dmThreadOpenSchema,
  dmThreadCloseSchema,
  dmTypingSchema,
} from "@src/socket/schemas.js";

export function dmThreadUserRoom(threadId: string, userId: number): string {
  return `dm:thread:${threadId}:user:${userId}`;
}

const handleThreadOpened = createHandler(
  "dm:thread.opened",
  dmThreadOpenSchema,
  async (payload, socket) => {
    await socket.join(dmThreadUserRoom(payload.threadId, socket.data.user.id));
    return { success: true };
  },
);

const handleThreadClosed = createHandler(
  "dm:thread.closed",
  dmThreadCloseSchema,
  async (payload, socket) => {
    await socket.leave(dmThreadUserRoom(payload.threadId, socket.data.user.id));
    return { success: true };
  },
);

const handleTyping = createHandler(
  "dm:typing",
  dmTypingSchema,
  async (payload, socket, context) => {
    const userId = socket.data.user.id;

    // GATE: can't be typing "at" yourself.
    if (userId === payload.peerUserId) {
      return { success: false, error: Errors.INVALID_PAYLOAD };
    }

    // GATE: rate limit — a fast typist must not flood the peer's socket.
    const allowed = await context.rateLimiter.isAllowed(
      `dm:typing:${userId}:${payload.threadId}`,
      config.RATE_LIMIT_TYPING_PER_WINDOW,
      config.RATE_LIMIT_TYPING_WINDOW_SECONDS,
    );
    if (!allowed) {
      return { success: false, error: Errors.RATE_LIMITED };
    }

    // EXECUTE: relay only to the peer's sockets with this thread open.
    // socket.to(...) also excludes the sender's own socket by default.
    socket
      .to(dmThreadUserRoom(payload.threadId, payload.peerUserId))
      .emit("dm:typing", {
        threadId: payload.threadId,
        userId,
      });

    return { success: true };
  },
);

export const inboxTypingHandler = (socket: Socket, context: AppContext) => {
  socket.on("dm:thread.opened", handleThreadOpened(socket, context));
  socket.on("dm:thread.closed", handleThreadClosed(socket, context));
  socket.on("dm:typing", handleTyping(socket, context));
};
