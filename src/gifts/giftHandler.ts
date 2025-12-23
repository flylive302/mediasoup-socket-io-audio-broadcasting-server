import type { Socket, Server } from "socket.io";
import type { Redis } from "ioredis";
import { GiftBuffer } from "./giftBuffer.js";
import { LaravelClient } from "../integrations/laravelClient.js";
import { logger } from "../core/logger.js";
import { sendGiftSchema, prepareGiftSchema } from "../socket/schemas.js";
import { RateLimiter } from "../utils/rateLimiter.js";

const GIFT_RATE_LIMIT = 30; // 30 gifts per minute
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

  handle(socket: Socket) {
    socket.on("gift:send", async (rawPayload: unknown) => {
      const user = socket.data.user;

      // Rate limit check
      const allowed = await this.rateLimiter.isAllowed(
        `gift:${user.id}`,
        GIFT_RATE_LIMIT,
        GIFT_RATE_WINDOW,
      );
      if (!allowed) {
        socket.emit("error", { message: "Too many gifts, please slow down" });
        return;
      }

      // Validate payload using Zod schema
      const payloadResult = sendGiftSchema.safeParse(rawPayload);
      if (!payloadResult.success) {
        socket.emit("error", {
          message: "Invalid gift payload",
          errors: payloadResult.error.format(),
        });
        return;
      }
      const payload = payloadResult.data;

      const transaction = {
        transaction_id: `g_${Date.now()}_${socket.id}_${Math.random().toString(36).substr(2, 5)}`,
        room_id: payload.roomId,
        sender_id: user.id,
        recipient_id: payload.recipientId,
        gift_id: payload.giftId,
        quantity: payload.quantity || 1,
        timestamp: Date.now(),
        sender_socket_id: socket.id,
      };

      // 2. Broadcast immediately (Optimistic UI)
      socket.to(payload.roomId).emit("gift:received", {
        senderId: user.id,
        senderName: user.name,
        senderAvatar: user.avatar, // Changed from avatar_url per protocol
        ...payload,
      });

      // 3. Queue for persistence
      await this.buffer.enqueue(transaction);
    });

    // ─────────────────────────────────────────────────────────────────
    // Gift Prepare (Preload Signaling)
    // Sender signals recipient to preload asset before sending
    // ─────────────────────────────────────────────────────────────────
    socket.on("gift:prepare", (rawPayload: unknown) => {
      // Validate payload
      const payloadResult = prepareGiftSchema.safeParse(rawPayload);
      if (!payloadResult.success) {
        // Silent fail - preload is best-effort
        return;
      }
      const payload = payloadResult.data;

      // Broadcast to room - all members will receive but only recipient should act
      // This is simpler than finding specific socket and still performant
      socket.to(payload.roomId).emit("gift:prepare", {
        giftId: payload.giftId,
        recipientId: payload.recipientId,
      });
    });
  }
}
