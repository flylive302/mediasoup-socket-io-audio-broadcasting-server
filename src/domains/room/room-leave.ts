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
import { releaseVideoOnRoomLeave } from "@src/domains/video-player/index.js";
import { releaseMusicOnRoomLeave } from "@src/domains/audio-player/index.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";

export async function performRoomLeave(
  socket: Socket,
  context: AppContext,
  roomId: string,
): Promise<void> {
  await finalizeLeave(socket, context, roomId, { viaDisconnect: false });
  // room-video-player/03: a Controller who leaves (or switches rooms) ends the
  // Room Video. Here, not in finalizeLeave — that also runs on disconnect, which
  // the video lifecycle hook covers. Never throws.
  await releaseVideoOnRoomLeave(socket, context, roomId);
  // room-music-playlist/02: the leaver's music (mutex, queue spot) goes with them,
  // behind the same "another live socket of this user in the room" guard as the
  // disconnect hook. finalizeLeave cleared the client's room, so the disconnect
  // hook can no longer see this room — nothing else would release it. Never throws.
  await releaseMusicOnRoomLeave(socket, context, roomId);
}
