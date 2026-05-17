/**
 * Handler for room:leave event.
 *
 * Delegates to the shared performRoomLeave() teardown (also used by the
 * implicit room-switch path in room:join — see F-31).
 */
import { createHandler, type HandlerResult } from "@src/shared/handler.utils.js";
import { leaveRoomSchema } from "@src/socket/schemas.js";
import { performRoomLeave } from "@src/domains/room/room-leave.js";

// ── Exported Handler ────────────────────────────────────────
export const leaveRoomHandler = createHandler(
  "room:leave",
  leaveRoomSchema,
  async (payload, socket, context): Promise<HandlerResult> => {
    await performRoomLeave(socket, context, payload.roomId);
    return { success: true };
  },
);
