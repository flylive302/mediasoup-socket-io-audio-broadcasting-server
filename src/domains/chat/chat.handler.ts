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

    // Rate limit check FIRST (cheap Redis op should run before handler logic)
    const allowed = await context.rateLimiter.isAllowed(
      `chat:${userId}`,
      config.RATE_LIMIT_MESSAGES_PER_MINUTE,
      60,
    );

    if (!allowed) {
      return { success: false, error: "Too many messages" };
    }

    const message = {
      id: randomUUID(),
      userId: socket.data.user.id,
      userName: socket.data.user.name,
      avatar: socket.data.user.avatar,
      content: payload.content,
      type: payload.type || "text",
      timestamp: Date.now(),
    };

    // Emit to everyone in room INCLUDING sender (simplifies frontend state sync)
    socket.nsp.to(payload.roomId).emit("chat:message", message);

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
