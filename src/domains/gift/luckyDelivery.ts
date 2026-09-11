/**
 * gift-backlog-and-lag 03: single choke point for delivering a room-wide
 * lucky win. Shared by the queued event-router path (Laravel's
 * `lucky:room-result` relay, still used while `GIFT_LUCKY_INLINE` is off)
 * and the new inline batch-response path in giftBuffer.ts (used once the
 * backend flag is on). Behaviour is unchanged from what event-router.ts did
 * inline before this ticket: while the room gift ticker is on
 * (`GIFT_ROOM_TICK_MS > 0`), the win rides the next merged `gift:batch` tick
 * instead of a direct emit — never dropped, just carried on the ticker's
 * cadence (gift-authority-tick-fanout 14). Ticker off → emit directly.
 */
import type { Server } from "socket.io";
import { giftRoomTickMs } from "./flags.js";
import { enqueueLucky } from "./roomTicker.js";

/** Returns the local (this-instance) socket count in the room — informational only. */
export function deliverLuckyRoomResult(io: Server, roomId: string, payload: unknown): number {
  if (giftRoomTickMs() > 0) {
    enqueueLucky(roomId, payload);
  } else {
    io.to(roomId).emit("lucky:room-result", payload);
  }
  return io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
}
