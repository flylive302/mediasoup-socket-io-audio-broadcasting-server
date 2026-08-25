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
import { emitToRoom } from "@src/shared/room-emit.js";
import { config } from "@src/config/index.js";
import { reactError } from "@src/shared/react-error.js";
import { giftLegacyShape, giftRoomTickMs } from "./flags.js";
import { enqueueGift, flushAllRooms } from "./roomTicker.js";

interface BurstFields {
  roomId: string;
  giftId: number;
  quantity?: number | undefined;
  batchId?: string | undefined;
}

export class GiftHandler {
  private readonly buffer: GiftBuffer;

  constructor(redis: Redis, io: Server, laravelClient: LaravelClient) {
    this.buffer = new GiftBuffer(redis, laravelClient, io, logger);
    this.buffer.start();
  }

  async stop(): Promise<void> {
    // gift-authority-tick-fanout 14: drain every room's accumulated
    // gift:batch state before the buffer/sockets stop, so a room never loses
    // an accepted-but-unemitted tap on shutdown.
    flushAllRooms();
    await this.buffer.stop();
  }

  /** See GiftBuffer.pendingCount — crash-shutdown accounting only. */
  async pendingCount(): Promise<number> {
    return this.buffer.pendingCount();
  }

  handle(socket: Socket, context: AppContext) {
    // lucky-burst-draw 08/04: `gift:send` is the single burst wire event.
    // New FE emits `recipientIds[]` (a real burst); stale/legacy FE keeps
    // emitting the scalar `recipientId` — normalized to a burst-of-1 here so
    // exactly one processing shape exists below the edge.
    socket.on(
      "gift:send",
      createHandler("gift:send", sendGiftSchema, async (payload, sock) => {
        const recipientIdsRaw = payload.recipientIds ?? [payload.recipientId as number];
        return this.processBurst(payload, recipientIdsRaw, sock, context);
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
          config.GIFT_RATE_LIMIT,
          config.GIFT_RATE_WINDOW,
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

  /**
   * lucky-burst-draw 08: the single burst pipeline behind `gift:send` —
   * real bursts (`recipientIds[]`) and legacy scalar sends normalized to a
   * burst-of-1. Strict GATE -> EXECUTE -> REACT.
   */
  private async processBurst(
    payload: BurstFields,
    recipientIdsRaw: number[],
    sock: Socket,
    context: AppContext,
  ) {
    const user = sock.data.user;

    // ── GATE ─────────────────────────────────────────────────
    if (!sock.rooms.has(payload.roomId)) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    const acceptedRecipientIds = await this.filterAcceptedRecipients(
      recipientIdsRaw,
      user.id,
      payload.roomId,
      context,
    );

    // GF-012 FIX (burst-native): self-gift is excluded per leg, silently —
    // it is not a rejection unless it drains the burst to zero.
    if (acceptedRecipientIds.length === 0) {
      return { success: false, error: Errors.NO_RECIPIENTS_SEATED };
    }

    // Rate limit check — per-event, not per-leg.
    // GF-009 FIX: Use shared context.rateLimiter instead of duplicate instance
    const allowed = await context.rateLimiter.isAllowed(
      `gift:${user.id}`,
      config.GIFT_RATE_LIMIT,
      config.GIFT_RATE_WINDOW,
    );
    if (!allowed) {
      // GF-010 FIX: Use shared error constant instead of plain string
      return { success: false, error: Errors.RATE_LIMITED };
    }

    // ── EXECUTE ──────────────────────────────────────────────

    const transaction = {
      transaction_id: randomUUID(),
      room_id: parseInt(payload.roomId, 10),
      sender_id: user.id,
      recipient_ids: acceptedRecipientIds,
      gift_id: payload.giftId,
      quantity: payload.quantity ?? 1,
      timestamp: Date.now(),
      sender_socket_id: sock.id,
      batch_id: payload.batchId,
    };

    // ── REACT ────────────────────────────────────────────────

    // Disconnect-log correlation counter (see AuthSocketData.giftSendCount).
    sock.data.giftSendCount = (sock.data.giftSendCount ?? 0) + 1;
    // gift-authority-tick-fanout 01: rate counterpart, see giftActivityWindow.
    sock.data.giftActivityWindow?.record(Date.now());

    this.broadcastReceived(sock, payload, user.id, acceptedRecipientIds, context, transaction.transaction_id);

    // BL-001 FIX: Record room activity to prevent auto-close during active gifting
    // GF-016 FIX: Log errors instead of silently swallowing
    context.autoCloseService.recordActivity(payload.roomId).catch((err) => {
      reactError(err, { roomId: payload.roomId }, "auto-close activity recording failed", { level: "debug" });
    });

    // Queue for persistence — exactly ONE row per burst.
    await this.buffer.enqueue(transaction);

    // `transaction_id` is returned so the sender can join its own gift to the
    // eventual `lucky:result` (echoed there as `reference_id`). It is the only
    // identifier that survives the whole path — the buffer is 1:N (one flush
    // POSTs up to MAX_BATCH_SIZE transactions from many sockets), so a
    // per-request correlation header structurally cannot attribute a result to
    // one sender. Purely additive; older clients ignore the field.
    return { success: true, acceptedRecipientIds, transaction_id: transaction.transaction_id };
  }

  /**
   * GATE: drops self-gift and unseated legs silently. Uses the same
   * seat-state source as the legacy single-recipient GF-017 check.
   */
  private async filterAcceptedRecipients(
    recipientIdsRaw: number[],
    senderId: number,
    roomId: string,
    context: AppContext,
  ): Promise<number[]> {
    const candidateIds = [...new Set(recipientIdsRaw)].filter((id) => id !== senderId);

    const accepted: number[] = [];
    for (const recipientId of candidateIds) {
      // GF-017 FIX: Verify recipient is seated in the room
      const seat = await context.seatRepository.getUserSeat(roomId, String(recipientId));
      if (seat !== null) {
        accepted.push(recipientId);
      }
    }
    return accepted;
  }

  /**
   * REACT: flag matrix from gift-authority-tick-fanout 14.
   *
   *  - `GIFT_LEGACY_SHAPE` on (default): today's dual-emit unchanged — one
   *    `gift:received` per accepted leg (exact legacy shape) so stale
   *    bundles keep rendering, then one burst-shaped `gift:received`
   *    (post-filter `recipientIds[]`) last.
   *  - `GIFT_ROOM_TICK_MS` > 0: this tap's leg ALSO (in addition to legacy,
   *    if legacy is also on) gets accumulated into the room's ticker instead
   *    of/as-well-as a direct emit — see roomTicker.ts. Sender exclusion for
   *    the ticker's merged `gift:batch` cannot be done per-recipient (one
   *    batch spans many senders), so it emits to the whole room with
   *    `senderId` on each item for the client to skip its own; see
   *    roomTicker.ts's module doc.
   *  - Both off: exactly ONE burst-shape `gift:received` per tap (no
   *    per-recipient loop) — sender still excluded as today.
   *
   * Flags are read fresh on every call (never cached) so a runtime flip
   * takes effect on the very next tap.
   */
  private broadcastReceived(
    sock: Socket,
    payload: BurstFields,
    senderId: number,
    acceptedRecipientIds: number[],
    context: AppContext,
    transactionId: string,
  ): void {
    const legacy = giftLegacyShape();
    const tickMs = giftRoomTickMs();

    if (legacy) {
      for (const recipientId of acceptedRecipientIds) {
        // GF-008 FIX: Explicitly pick emitted fields instead of spreading payload
        emitToRoom(sock, payload.roomId, "gift:received", {
          senderId,
          roomId: payload.roomId,
          giftId: payload.giftId,
          recipientId,
          quantity: payload.quantity,
          batchId: payload.batchId,
        }, context.cascadeRelay);
      }

      emitToRoom(sock, payload.roomId, "gift:received", {
        senderId,
        roomId: payload.roomId,
        giftId: payload.giftId,
        recipientIds: acceptedRecipientIds,
        quantity: payload.quantity,
        batchId: payload.batchId,
      }, context.cascadeRelay);
    } else if (tickMs <= 0) {
      // Both flags off: exactly one burst-shape emit per tap.
      emitToRoom(sock, payload.roomId, "gift:received", {
        senderId,
        roomId: payload.roomId,
        giftId: payload.giftId,
        recipientIds: acceptedRecipientIds,
        quantity: payload.quantity,
        batchId: payload.batchId,
      }, context.cascadeRelay);
    }

    if (tickMs > 0) {
      // roomTicker is wired once (io + live cascadeRelay source) at bootstrap
      // in server.ts — see initRoomTicker() there.
      enqueueGift(payload.roomId, {
        senderId,
        giftId: payload.giftId,
        recipientIds: acceptedRecipientIds,
        quantity: payload.quantity ?? 1,
        transactionId,
      });
    }
  }
}
