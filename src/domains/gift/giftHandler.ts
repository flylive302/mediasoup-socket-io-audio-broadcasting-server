import { randomUUID } from "node:crypto";
import type { Socket, Server } from "socket.io";
import type { Redis } from "ioredis";
import { GiftBuffer } from "./giftBuffer.js";
import { LaravelClient } from "@src/integrations/laravelClient.js";
import { logger } from "@src/infrastructure/logger.js";
import { sendGiftSchema, prepareGiftSchema } from "@src/socket/schemas.js";
import { RateLimiter } from "@src/utils/rateLimiter.js";
import { createHandler } from "@src/shared/handler.utils.js";
import type { AppContext } from "@src/context.js";

const GIFT_RATE_LIMIT = 330; // 330 gifts per minute
const GIFT_RATE_WINDOW = 60; // 60 seconds

export class GiftHandler {
  private readonly buffer: GiftBuffer;
  private readonly rateLimiter: RateLimiter;

  constructor(redis: Redis, io: Server, laravelClient: LaravelClient) {
    this.buffer = new GiftBuffer(redis, laravelClient, io, logger);
    this.rateLimiter = new RateLimiter(redis);
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

        // Rate limit check
        const allowed = await this.rateLimiter.isAllowed(
          `gift:${user.id}`,
          GIFT_RATE_LIMIT,
          GIFT_RATE_WINDOW,
        );
        if (!allowed) {
          return { success: false, error: "Too many gifts, please slow down" };
        }

        const transaction = {
          transaction_id: randomUUID(),
          room_id: payload.roomId,
          sender_id: user.id,
          recipient_id: payload.recipientId,
          gift_id: payload.giftId,
          quantity: payload.quantity || 1,
          timestamp: Date.now(),
          sender_socket_id: sock.id,
        };

        // BL-007 FIX: Removed senderName/senderAvatar — frontend looks up from participants
        sock.to(payload.roomId).emit("gift:received", {
          senderId: user.id,
          ...payload,
        });

        // BL-001 FIX: Record room activity to prevent auto-close during active gifting
        context.autoCloseService.recordActivity(payload.roomId).catch(() => {});

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
        // Broadcast to room - all members will receive but only recipient should act
        sock.to(payload.roomId).emit("gift:prepare", {
          giftId: payload.giftId,
          recipientId: payload.recipientId,
        });

        return { success: true };
      })(socket, context),
    );
  }
}