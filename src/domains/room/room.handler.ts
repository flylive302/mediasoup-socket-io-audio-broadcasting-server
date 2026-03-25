/**
 * Room handler — wires room socket events to handler functions.
 *
 * Each handler uses createHandler() for consistent GATE → EXECUTE → REACT.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { joinRoomHandler } from "./handlers/join-room.handler.js";
import { leaveRoomHandler } from "./handlers/leave-room.handler.js";

export const roomHandler = (socket: Socket, context: AppContext) => {
  socket.on("room:join", joinRoomHandler(socket, context));
  socket.on("room:leave", leaveRoomHandler(socket, context));
};
