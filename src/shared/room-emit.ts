/**
 * Room Emit — Cascade-aware room broadcasting utilities
 *
 * Two patterns for local broadcasting, both relay to remote instances:
 *
 *   emitToRoom()      — socket.to(roomId)  → excludes sender
 *   broadcastToRoom() — nsp.to(roomId)     → includes sender
 *
 * Usage:
 *   // Excludes sender (user joins, leaves, produces audio):
 *   emitToRoom(socket, roomId, "room:userJoined", data, cascadeRelay);
 *
 *   // Includes sender (admin mute, seat lock, chat):
 *   broadcastToRoom(socket.nsp, roomId, "seat:locked", data, cascadeRelay);
 */
import type { Socket, Server, Namespace } from "socket.io";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import { logger } from "@src/infrastructure/logger.js";

// ─── Relay Helper ───────────────────────────────────────────────

function relayCrossRegion(
  cascadeRelay: CascadeRelay | null,
  roomId: string,
  event: string,
  data: unknown,
): void {
  if (cascadeRelay?.hasRemotes(roomId)) {
    cascadeRelay.relayToRemote(roomId, event, data).catch((err) => {
      logger.warn({ err, roomId, event }, "Cross-region relay failed");
    });
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Emit to all users in a room EXCEPT the sender, plus relay cross-region.
 * Use for events triggered by a user action where the sender already knows the outcome
 * (e.g. room:userJoined, audio:newProducer, gift:received).
 */
export function emitToRoom(
  socket: Socket,
  roomId: string,
  event: string,
  data: unknown,
  cascadeRelay: CascadeRelay | null,
): void {
  socket.to(roomId).emit(event, data);
  relayCrossRegion(cascadeRelay, roomId, event, data);
}

/**
 * Broadcast to ALL users in a room INCLUDING the sender, plus relay cross-region.
 * Use for admin/server events where the acting user also needs the UI update
 * (e.g. seat:locked, seat:userMuted, chat:message, room:closed).
 */
export function broadcastToRoom(
  nsp: Server | Namespace,
  roomId: string,
  event: string,
  data: unknown,
  cascadeRelay: CascadeRelay | null,
): void {
  nsp.to(roomId).emit(event, data);
  relayCrossRegion(cascadeRelay, roomId, event, data);
}
