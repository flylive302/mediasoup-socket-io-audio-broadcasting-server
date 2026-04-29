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
 *
 * ── Why the `.local` flag when cascade is enabled ──────────────────────────
 * With multiple instances behind a single Redis pub/sub adapter, a plain
 * `socket.to(roomId).emit()` is delivered to every instance with sockets in
 * that room. For most events that's fine — payloads are instance-agnostic.
 *
 * For `audio:newProducer` it is NOT fine: the payload's `producerId` is
 * meaningful only on the originating instance. Edges must consume against
 * an EDGE-LOCAL producer id, which the cascade-relay HTTP path rewrites
 * before it broadcasts on the edge (see `internal.ts /internal/cascade/relay`).
 * The Redis adapter delivers the un-rewritten payload first (~ms) and the
 * edge listener errors with "Cannot consume" before the relayed (rewritten)
 * event arrives.
 *
 * Fix: when cascade is enabled, restrict the local emit to *this* node
 * (`.local.to(roomId)`) and rely on the cascade-relay HTTP path as the
 * single cross-instance delivery channel. When cascade is off (single
 * instance or dev), keep the adapter path so behavior is unchanged.
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
  if (cascadeRelay) {
    socket.local.to(roomId).emit(event, data);
  } else {
    socket.to(roomId).emit(event, data);
  }
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
  if (cascadeRelay) {
    nsp.local.to(roomId).emit(event, data);
  } else {
    nsp.to(roomId).emit(event, data);
  }
  relayCrossRegion(cascadeRelay, roomId, event, data);
}
