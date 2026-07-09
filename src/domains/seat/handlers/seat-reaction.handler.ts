/**
 * seat:reaction - Seated user plays a Seat Reaction (ADR 0015)
 *
 * GATE (pure-ish, no mutation): sender in room, sender occupies a Seat,
 * rate-limited ~1/1.5s.
 * EXECUTE: broadcast to the room INCLUDING sender — the sender renders from
 * the broadcast, no local echo.
 * No REACT stage — nothing persisted, nothing buffered.
 */
import { seatReactionSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { Errors } from "@src/shared/errors.js";

export const seatReactionHandler = createHandler(
  "seat:reaction",
  seatReactionSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, code } = payload;

    // GATE — sender must be a room participant
    if (!socket.rooms.has(roomId)) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // GATE — sender must currently occupy a Seat
    const seatIndex = await context.seatRepository.getUserSeat(roomId, userId);
    if (seatIndex === null) {
      return { success: false, error: Errors.NOT_SEATED };
    }

    // GATE — rate limit (~1 per 1.5s per sender)
    const allowed = await context.rateLimiter.isAllowed(
      `seat:reaction:${userId}:${roomId}`,
      config.RATE_LIMIT_SEAT_REACTIONS_PER_WINDOW,
      config.RATE_LIMIT_SEAT_REACTIONS_WINDOW_SECONDS,
    );
    if (!allowed) {
      return { success: false, error: Errors.RATE_LIMITED };
    }

    // EXECUTE — broadcast to everyone in the room, sender included
    broadcastToRoom(
      socket.nsp,
      roomId,
      "seat:reaction",
      { userId: socket.data.user.id, code },
      context.cascadeRelay,
    );

    logger.debug({ roomId, userId, code }, "Seat reaction broadcast");

    return { success: true };
  },
);
