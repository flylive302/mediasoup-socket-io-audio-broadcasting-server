import { randomUUID } from "node:crypto";
import type { Socket, Server } from "socket.io";
import type { Redis } from "ioredis";
import { GiftBuffer } from "./giftBuffer.js";
import { LaravelClient } from "@src/integrations/laravelClient.js";
import { logger } from "@src/infrastructure/logger.js";
import { sendGiftSchema, prepareGiftSchema } from "@src/socket/schemas.js";

import { createHandler } from "@src/shared/handler.utils.js";
import { Errors } from "@src/shared/errors.js";
import type { AppContext } from "@src/context.js";

const GIFT_RATE_LIMIT = 330; // 330 gifts per minute
const GIFT_RATE_WINDOW = 60; // 60 seconds

export class GiftHandler {
  private readonly buffer: GiftBuffer;

  constructor(redis: Redis, io: Server, laravelClient: LaravelClient) {
    this.buffer = new GiftBuffer(redis, laravelClient, io, logger);
    this.buffer.start();
  }

  async stop(): Promise<void> {
    await this.buffer.stop();
  }

  handle(socket: Socket, context: AppContext) {
    socket.on(
      "gift:send",
      createHandler("gift:send", sendGiftSchema, async (payload, sock) => {
        const user = sock.data.user;

        // GF-001 FIX: Verify sender is actually in the target room
        if (!sock.rooms.has(payload.roomId)) {
          return { success: false, error: Errors.NOT_IN_ROOM };
        }

        // GF-012 FIX: Prevent self-gifting
        if (user.id === payload.recipientId) {
          return { success: false, error: Errors.CANNOT_GIFT_SELF };
        }

        // Rate limit check
        // GF-009 FIX: Use shared context.rateLimiter instead of duplicate instance
        const allowed = await context.rateLimiter.isAllowed(
          `gift:${user.id}`,
          GIFT_RATE_LIMIT,
          GIFT_RATE_WINDOW,
        );
        if (!allowed) {
          // GF-010 FIX: Use shared error constant instead of plain string
          return { success: false, error: Errors.RATE_LIMITED };
        }

        const transaction = {
          transaction_id: randomUUID(),
          room_id: payload.roomId,
          sender_id: user.id,
          recipient_id: payload.recipientId,
          gift_id: payload.giftId,
          quantity: payload.quantity ?? 1,
          timestamp: Date.now(),
          sender_socket_id: sock.id,
        };

        // GF-008 FIX: Explicitly pick emitted fields instead of spreading payload
        sock.to(payload.roomId).emit("gift:received", {
          senderId: user.id,
          roomId: payload.roomId,
          giftId: payload.giftId,
          recipientId: payload.recipientId,
          quantity: payload.quantity,
        });

        // BL-001 FIX: Record room activity to prevent auto-close during active gifting
        // GF-016 FIX: Log errors instead of silently swallowing
        context.autoCloseService.recordActivity(payload.roomId).catch((err) => {
          logger.debug({ err, roomId: payload.roomId }, "auto-close activity recording failed");
        });

        // Queue for persistence
        await this.buffer.enqueue(transaction);

        return { success: true };
      })(socket, context),
    );

    // ─────────────────────────────────────────────────────────────────
    // Gift Prepare (Preload Signaling)
    // Sender signals recipient to preload asset before sending
    // ─────────────────────────────────────────────────────────────────
    socket.on(
      "gift:prepare",
      createHandler("gift:prepare", prepareGiftSchema, async (payload, sock) => {
        const user = sock.data.user;

        // GF-001 FIX: Verify sender is in the target room
        if (!sock.rooms.has(payload.roomId)) {
          return { success: false, error: Errors.NOT_IN_ROOM };
        }

        // GF-004 FIX: Rate-limit prepare signals to prevent abuse
        // GF-009 FIX: Use shared context.rateLimiter instead of duplicate instance
        const allowed = await context.rateLimiter.isAllowed(
          `gift:prepare:${user.id}`,
          GIFT_RATE_LIMIT,
          GIFT_RATE_WINDOW,
        );
        if (!allowed) {
          return { success: false, error: Errors.RATE_LIMITED };
        }

        // GF-005 FIX: Targeted emit to recipient only (saves bandwidth on N-2 uninvolved clients)
        const recipientSocketIds = await context.userSocketRepository.getSocketIds(payload.recipientId);
        if (recipientSocketIds.length > 0) {
          context.io.to(recipientSocketIds).emit("gift:prepare", {
            giftId: payload.giftId,
            recipientId: payload.recipientId,
          });
        }

        return { success: true };
      })(socket, context),
    );
  }
}