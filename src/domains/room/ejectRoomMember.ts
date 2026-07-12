/**
 * Room member ejection (ADR 0017 — unified kick path).
 *
 * Kicking a user is now Laravel-authoritative: `POST /rooms/{room}/blocks`
 * creates the block, then Laravel's event fanout publishes
 * `room.member_removed`. MSAB no longer accepts a direct client `room:kick`
 * emit — this module is the ejection machinery that WAS in the retired
 * `kick-user.handler.ts`, now driven by the EventRouter's fanout ingest
 * instead of a socket handler. Behavior is otherwise unchanged: clear any
 * seat the user holds, force their socket(s) out of the Socket.IO room,
 * update participant count/Laravel status, and notify remaining members.
 */
import type { Server } from "socket.io";
import type { Logger } from "@src/infrastructure/logger.js";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";
import type { ClientManager } from "@src/client/clientManager.js";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";
import type { StatusCoalescer } from "@src/domains/room/status-coalescer.js";
import type { UserRoomRepository } from "@src/integrations/laravel/user-room.repository.js";
import { config } from "@src/config/index.js";

export interface EjectRoomMemberDeps {
  io: Server;
  seatRepository: SeatRepository;
  clientManager: ClientManager;
  roomStateRepo: RoomStateRepository;
  statusCoalescer: StatusCoalescer;
  userRoomRepository: UserRoomRepository;
  logger: Logger;
}

export async function ejectRoomMember(
  deps: EjectRoomMemberDeps,
  roomId: string,
  targetUserId: number,
): Promise<void> {
  const {
    io,
    seatRepository,
    clientManager,
    roomStateRepo,
    statusCoalescer,
    userRoomRepository,
    logger,
  } = deps;
  const targetUserIdStr = String(targetUserId);

  // 1. Clear the user's seat if seated (F-41: clear every seat they held).
  const seatResult = await seatRepository.leaveSeat(roomId, targetUserIdStr);
  if (seatResult.success) {
    const cleared = seatResult.clearedSeatIndices ?? [seatResult.seatIndex];
    for (const seatIndex of cleared) {
      io.to(roomId).emit("seat:cleared", { seatIndex, userId: targetUserId });
    }
    logger.debug(
      { roomId, targetUserId, clearedSeatIndices: cleared },
      "Ejected user's seat cleared",
    );
  }

  // 2. Force every one of the target's sockets out of the Socket.IO room
  // (cross-node safe via fetchSockets()). The client also self-ejects on
  // receiving room.member_removed (leaveRoom + navigate away); this is the
  // server-side guarantee that holds even if the client ignores it.
  const targetSockets = (await io.in(roomId).fetchSockets()).filter(
    (socket) => String(socket.data?.user?.id) === targetUserIdStr,
  );

  let locallyEjected = 0;
  for (const targetSocket of targetSockets) {
    targetSocket.leave(roomId);

    const localClient = clientManager.getClient(targetSocket.id);
    if (localClient) {
      clientManager.clearClientRoom(targetSocket.id);
      locallyEjected++;
    }
  }

  // 3. Update room state + Laravel status (coalesced) + clear cached room membership.
  const [newCount] = await Promise.all([
    roomStateRepo.adjustParticipantCount(
      roomId,
      locallyEjected > 0 ? -locallyEjected : 0,
    ),
    userRoomRepository.clearUserRoom(targetUserId),
  ]);

  if (newCount !== null) {
    const isLive = newCount > 0;
    statusCoalescer.submit(roomId, {
      is_live: isLive,
      participant_count: newCount,
      hosting_region: isLive ? config.AWS_REGION : null,
      hosting_ip: isLive ? (config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null) : null,
      hosting_port: isLive ? config.PORT : null,
    });
  }

  // 4. Broadcast to remaining members. room.member_removed itself already
  // reaches the target (Laravel's fanout targets user_id AND room_id), so
  // this only needs to notify the rest of the room the seat/roster changed.
  if (targetSockets.length > 0) {
    io.to(roomId).emit("room:userLeft", { userId: targetUserId });
  }

  logger.info(
    { roomId, targetUserId, locallyEjected },
    "User ejected from room via block fanout",
  );
}
