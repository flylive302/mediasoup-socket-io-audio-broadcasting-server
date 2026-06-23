/**
 * Explicit room-leave entry point.
 *
 * Thin wrapper over the shared `finalizeLeave` teardown (realtime-01), which is
 * also used by the `disconnect` path so both leave routes update the backend
 * identically. Used by the `room:leave` handler AND the implicit room-switch
 * path in `room:join` (F-31: previously `room:join` never left the prior
 * Socket.IO room / cleared its seat / decremented its count, so a user who
 * switched rooms without an explicit leave stayed a ghost member of the old
 * room — still receiving its broadcasts and holding its seat).
 */
import { finalizeLeave } from "./leave-finalizer.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";

export async function performRoomLeave(
  socket: Socket,
  context: AppContext,
  roomId: string,
): Promise<void> {
  await finalizeLeave(socket, context, roomId, { viaDisconnect: false });
}
