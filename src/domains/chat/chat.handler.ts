import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { chatMessageSchema } from "@src/socket/schemas.js";
import type { AppContext } from "@src/context.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { Errors } from "@src/shared/errors.js";
import { reactError } from "@src/shared/react-error.js";
import { maskProfanity } from "@src/domains/chat/profanity.js";

const handleChatMessage = createHandler(
  "chat:message",
  chatMessageSchema,
  async (payload, socket, context) => {
    const userId = socket.data.user.id;

    // CF-001: Verify sender belongs to this room (O(1) Set lookup, zero Redis cost)
    if (!socket.rooms.has(payload.roomId)) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // Rate limit check FIRST (cheap Redis op should run before handler logic)
    const allowed = await context.rateLimiter.isAllowed(
      `chat:${userId}:${payload.roomId}`,
      config.RATE_LIMIT_MESSAGES_PER_MINUTE,
      60,
    );

    if (!allowed) {
      return { success: false, error: Errors.RATE_LIMITED };
    }

    // Apple Guideline 1.2: mask objectionable words in free-text chat before
    // broadcast. Only "text" messages carry user-authored prose — system/gift/
    // emoji/sticker types are structured payloads, not free text, so they're
    // left untouched.
    let content = payload.content;
    if (config.CHAT_PROFANITY_FILTER_ENABLED && payload.type === "text") {
      const filtered = maskProfanity(payload.content);
      content = filtered.text;
      if (filtered.masked) {
        logger.debug({ roomId: payload.roomId, userId, masked: true }, "Chat message masked");
      }
    }

    // Include a lightweight author snapshot. The frontend still prefers its
    // live participants map, but cross-region/rejoin races can leave that map
    // incomplete when chat arrives before room:userJoined/profile sync.
    const message = {
      id: randomUUID(),
      userId,
      userName: socket.data.user.name,
      userAvatar: socket.data.user.avatar,
      userFrameId: socket.data.user.frame_id,
      userChatBubbleId: socket.data.user.chat_bubble_id,
      content,
      type: payload.type,
      timestamp: Date.now(),
    };

    // Emit to everyone in room INCLUDING sender (simplifies frontend state sync)
    broadcastToRoom(socket.nsp, payload.roomId, "chat:message", message, context.cascadeRelay);

    // BL-001 FIX: Record room activity to prevent auto-close during active chat
    context.autoCloseService.recordActivity(payload.roomId).catch((err) => {
      reactError(err, { roomId: payload.roomId }, "recordActivity failed", { level: "debug" });
    });

    logger.debug(
      { roomId: payload.roomId, userId: message.userId },
      "Chat message",
    );

    return { success: true };
  },
);

export const chatHandler = (socket: Socket, context: AppContext) => {
  socket.on("chat:message", handleChatMessage(socket, context));
};
