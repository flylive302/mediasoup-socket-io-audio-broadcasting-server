/**
 * User Handler - User-related socket events
 * 
 * Handles user:getRoom for tracking feature
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import { getUserRoomSchema } from "@src/socket/schemas.js";
import { Errors } from "@src/shared/errors.js";

export const userHandler = (socket: Socket, context: AppContext) => {
  const { userSocketRepository } = context;

  /**
   * Get the room a user is currently in
   * Used for Track feature on profile page
   */
  socket.on("user:getRoom", async (rawPayload: unknown, ack) => {
    const parseResult = getUserRoomSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      if (ack) ack({ roomId: null, error: Errors.INVALID_PAYLOAD });
      return;
    }

    const { userId } = parseResult.data;

    try {
      const roomId = await userSocketRepository.getUserRoom(userId);
      
      logger.debug({ userId, roomId }, "user:getRoom result");
      
      if (ack) ack({ roomId });
    } catch (err) {
      logger.error({ err, userId }, "user:getRoom failed");
      if (ack) ack({ roomId: null, error: Errors.INTERNAL_ERROR });
    }
  });
};
