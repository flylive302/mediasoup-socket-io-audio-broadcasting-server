import type { Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import { chatMessageSchema } from "@src/socket/schemas.js";
import { Errors } from "@src/shared/errors.js";
import type { AppContext } from "@src/context.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";

export const chatHandler = (socket: Socket, context: AppContext) => {
  const { rateLimiter } = context;

  socket.on("chat:message", async (rawPayload: unknown) => {
    // Rate limit check FIRST (cheap Redis op should run before Zod parsing)
    const userId = socket.data.user.id;
    const allowed = await rateLimiter.isAllowed(
      `chat:${userId}`,
      config.RATE_LIMIT_MESSAGES_PER_MINUTE,
      60,
    );

    if (!allowed) {
      socket.emit("error", { message: "Too many messages" });
      return;
    }

    // Validation
    const payloadResult = chatMessageSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      socket.emit("error", {
        message: Errors.INVALID_PAYLOAD,
        errors: payloadResult.error.format(),
      });
      return;
    }
    const payload = payloadResult.data;

    // Broadcast to room (excluding sender) or including sender?
    // Usually sender wants ACK, others get event.
    // Or sender appends optimistically.

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
  });
};
