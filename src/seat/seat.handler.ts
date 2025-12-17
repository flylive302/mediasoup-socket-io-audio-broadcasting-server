/**
 * Seat Domain Handler Junction
 * Registers all seat-related socket event handlers
 */
import type { Socket } from "socket.io";
import type { AppContext } from "../context.js";
import { logger } from "../core/logger.js";

// Import individual handlers
import { takeSeatHandler } from "./handlers/take-seat.handler.js";
import { leaveSeatHandler } from "./handlers/leave-seat.handler.js";
import { assignSeatHandler } from "./handlers/assign-seat.handler.js";
import { removeSeatHandler } from "./handlers/remove-seat.handler.js";
import { muteSeatHandler } from "./handlers/mute-seat.handler.js";
import { unmuteSeatHandler } from "./handlers/unmute-seat.handler.js";
import { lockSeatHandler } from "./handlers/lock-seat.handler.js";
import { unlockSeatHandler } from "./handlers/unlock-seat.handler.js";
import { inviteSeatHandler } from "./handlers/invite-seat.handler.js";
import {inviteAcceptHandler,inviteDeclineHandler} from "./handlers/invite-response.handler.js";

// Re-export state functions for use by other modules
export {
  getRoomSeats,
  clearUserSeat,
  setRoomOwner,
  getLockedSeats,
  clearRoomState,
} from "./seat.state.js";

/**
 * Register all seat-related socket event handlers
 */
export function registerSeatHandlers(socket: Socket, context: AppContext): void {
  const userId = String(socket.data.user.id);
  logger.info({ socketId: socket.id, userId }, "Seat handlers registered");

  // User actions
  socket.on("seat:take", takeSeatHandler(socket, context));
  socket.on("seat:leave", leaveSeatHandler(socket, context));

  // Owner actions
  socket.on("seat:assign", assignSeatHandler(socket, context));
  socket.on("seat:remove", removeSeatHandler(socket, context));
  socket.on("seat:mute", muteSeatHandler(socket, context));
  socket.on("seat:unmute", unmuteSeatHandler(socket, context));
  socket.on("seat:lock", lockSeatHandler(socket, context));
  socket.on("seat:unlock", unlockSeatHandler(socket, context));

  // Invite flow
  socket.on("seat:invite", inviteSeatHandler(socket, context));
  socket.on("seat:invite:accept", inviteAcceptHandler(socket, context));
  socket.on("seat:invite:decline", inviteDeclineHandler(socket, context));
}
