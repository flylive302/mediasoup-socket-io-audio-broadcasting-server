/**
 * Socket broadcast utilities — DRY extraction of common emission patterns
 */
import type { Socket } from "socket.io";

/**
 * Emit an event to all users in a room INCLUDING the sender.
 * Replaces the repeated pattern: socket.to(roomId).emit(...) + socket.emit(...)
 */
export function emitToRoom(
  socket: Socket,
  roomId: string,
  event: string,
  data: unknown,
): void {
  socket.to(roomId).emit(event, data);
  socket.emit(event, data);
}
