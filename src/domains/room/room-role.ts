/**
 * Room Role — per-room rank badge (room-role-badge)
 *
 * Seats and the participant list show a rank badge (owner / admin / member;
 * nothing for a plain visitor). The rank is resolved ONCE per join, never per
 * seat change, and carried on the socket so the join snapshot hands every
 * later joiner the badges with no extra lookup.
 *
 * Lifecycle:
 *   room:join  → join acks immediately (no await on Laravel)
 *              → background `getMemberRole` → tag socket → `room:userRole`
 *   membership relay events (joined / left / removed / role_changed)
 *              → re-tag the user's local sockets → `room:userRole`
 *
 * The tag carries its roomId, so a socket that moves rooms can never leak a
 * rank from the previous room — a mismatched tag reads as "no role".
 */
import type { Server, Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import type { UserSocketRepository } from "@src/integrations/laravel/user-socket.repository.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { reactError } from "@src/shared/react-error.js";
import { logger } from "@src/infrastructure/logger.js";

export type RoomRole = "owner" | "admin" | "member";

export interface RoomRoleTag {
  roomId: string;
  role: RoomRole | null;
}

/** Outgoing event: `{ userId, role }` — role null clears the badge. */
export const ROOM_USER_ROLE_EVENT = "room:userRole";

/** Minimal socket-data shape — satisfied by live and remote (fetchSockets) sockets. */
interface RoleTagged {
  roomRole?: RoomRoleTag;
}

/**
 * The socket's rank in `roomId`: the role (null = resolved visitor), or
 * undefined when not yet resolved / tagged for another room. Undefined is
 * dropped from the JSON snapshot, so a client merging it keeps a rank it
 * already learned instead of having it wiped by an in-flight lookup.
 */
export function roomRoleFor(
  data: RoleTagged | undefined,
  roomId: string,
): RoomRole | null | undefined {
  const tag = data?.roomRole;
  return tag && tag.roomId === roomId ? tag.role : undefined;
}

/**
 * REACT (fire-and-forget) for `room:join`: resolve the joiner's rank without
 * delaying the join, tag the socket, and announce it to the room (sender
 * included, so the joiner sees their own badge). `getMemberRole` already
 * degrades to null on any Laravel error — a slow or failing lookup costs a
 * missing badge, never a slow or failed join.
 */
export function resolveJoinerRoomRole(
  socket: Socket,
  roomId: string,
  context: AppContext,
): void {
  const userId: number = socket.data.user.id;

  // Deferred into the promise chain so even a synchronous throw from the
  // client lands in .catch — this runs inside afterJoin and must never fail
  // the join it decorates.
  void Promise.resolve()
    .then(() => context.laravelClient.getMemberRole(roomId, String(userId)))
    .then((role) => {
      // The user may have left (or hopped rooms) while Laravel answered.
      if (!socket.connected || !socket.rooms.has(roomId)) return;

      socket.data.roomRole = { roomId, role } satisfies RoomRoleTag;

      // No rank = no badge, which is already every client's default.
      if (role === null) return;

      broadcastToRoom(
        socket.nsp,
        roomId,
        ROOM_USER_ROLE_EVENT,
        { userId, role },
        context.cascadeRelay,
      );
    })
    .catch((err) =>
      reactError(err, { roomId, userId }, "Failed to resolve joiner room role", {
        logger,
      }),
    );
}

/**
 * EXECUTE (per instance) for membership relay events: re-tag this user's
 * LOCAL sockets that are in `roomId`, so the next join snapshot is current.
 * Every instance runs this; only the fan-out claim winner emits the event.
 */
export async function retagRoomRoleOnLocalSockets(
  io: Server,
  userSocketRepo: UserSocketRepository,
  roomId: string,
  userId: number,
  role: RoomRole | null,
): Promise<void> {
  const socketIds = await userSocketRepo.getSocketIds(userId);
  for (const socketId of socketIds) {
    const s = io.sockets.sockets.get(socketId);
    if (s?.rooms.has(roomId)) {
      s.data.roomRole = { roomId, role } satisfies RoomRoleTag;
    }
  }
}

/**
 * Map a Laravel membership relay event to the user's new rank in the room.
 * Returns undefined when the event carries no usable rank change.
 */
export function roleFromMembershipEvent(
  event: string,
  payload: Record<string, unknown>,
): RoomRole | null | undefined {
  switch (event) {
    case "room.member_joined":
      return toRoomRole(payload.role) ?? "member";
    case "room.member_role_changed":
      return toRoomRole(payload.new_role);
    case "room.member_left":
    case "room.member_removed":
      return null;
    default:
      return undefined;
  }
}

function toRoomRole(value: unknown): RoomRole | undefined {
  return value === "owner" || value === "admin" || value === "member"
    ? value
    : undefined;
}
