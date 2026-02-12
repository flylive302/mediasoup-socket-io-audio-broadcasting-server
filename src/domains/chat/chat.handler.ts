import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { chatMessageSchema } from "@src/socket/schemas.js";
import type { AppContext } from "@src/context.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { createHandler } from "@src/shared/handler.utils.js";

const handleChatMessage = createHandler(
  "chat:message",
  chatMessageSchema,
  async (payload, socket, context) => {
    const userId = socket.data.user.id;

    // CF-001: Verify sender belongs to this room (O(1) Set lookup, zero Redis cost)
    if (!socket.rooms.has(payload.roomId)) {
      return { success: false, error: "Not in room" };
    }

    // Rate limit check FIRST (cheap Redis op should run before handler logic)
    const allowed = await context.rateLimiter.isAllowed(
      `chat:${userId}:${payload.roomId}`,
      config.RATE_LIMIT_MESSAGES_PER_MINUTE,
      60,
    );

    if (!allowed) {
      return { success: false, error: "Too many messages" };
    }

    const message = {
      id: randomUUID(),
      userId,
      userName: socket.data.user.name,
      avatar: socket.data.user.avatar,
      content: payload.content,
      type: payload.type,
      timestamp: Date.now(),
    };

    // Emit to everyone in room INCLUDING sender (simplifies frontend state sync)
    socket.nsp.in(payload.roomId).emit("chat:message", message);

    // BL-001 FIX: Record room activity to prevent auto-close during active chat
    context.autoCloseService.recordActivity(payload.roomId).catch((err) => {
      logger.debug({ err, roomId: payload.roomId }, "recordActivity failed");
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
