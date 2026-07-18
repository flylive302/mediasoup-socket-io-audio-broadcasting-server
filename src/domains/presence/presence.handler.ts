/**
 * DM Presence subscribe/unsubscribe (dm-realtime-platform/07, Fable design).
 *
 * Presence is never a global fan-out (ADR 0021). A socket joins
 * `presence:user:{id}` rooms only for the contacts it explicitly subscribes
 * to (open inbox list / open thread on the FE), capped at
 * PRESENCE_SUBSCRIBE_MAX ids per socket. `presence:subscribe` returns a
 * snapshot so the FE renders instantly and self-heals any push it missed
 * while not yet subscribed. Socket.IO auto-leaves all rooms on disconnect —
 * no explicit cleanup hook is needed for that path.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { config } from "@src/config/index.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { Errors } from "@src/shared/errors.js";
import {
  presenceSubscribeSchema,
  presenceUnsubscribeSchema,
} from "@src/socket/schemas.js";
import { presenceUserRoom } from "./presence.service.js";

const handleSubscribe = createHandler(
  "presence:subscribe",
  presenceSubscribeSchema,
  async (payload, socket, context) => {
    // GATE
    if (payload.userIds.length > config.PRESENCE_SUBSCRIBE_MAX) {
      return { success: false, error: Errors.INVALID_PAYLOAD };
    }

    // EXECUTE
    await Promise.all(
      payload.userIds.map((userId) => socket.join(presenceUserRoom(userId))),
    );
    const snapshot = await context.presenceService.snapshot(payload.userIds);

    return { success: true, data: snapshot };
  },
);

const handleUnsubscribe = createHandler(
  "presence:unsubscribe",
  presenceUnsubscribeSchema,
  async (payload, socket) => {
    // GATE
    if (payload.userIds.length > config.PRESENCE_SUBSCRIBE_MAX) {
      return { success: false, error: Errors.INVALID_PAYLOAD };
    }

    // EXECUTE
    await Promise.all(
      payload.userIds.map((userId) => socket.leave(presenceUserRoom(userId))),
    );

    return { success: true };
  },
);

export const presenceHandler = (socket: Socket, context: AppContext) => {
  socket.on("presence:subscribe", handleSubscribe(socket, context));
  socket.on("presence:unsubscribe", handleUnsubscribe(socket, context));
};
