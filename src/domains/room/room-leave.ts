/**
 * Shared room-leave teardown.
 *
 * One implementation used by both the explicit `room:leave` handler and the
 * implicit room-switch path in `room:join` (F-31: previously `room:join` never
 * left the prior Socket.IO room / cleared its seat / decremented its count, so
 * a user who switched rooms without an explicit leave stayed a ghost member of
 * the old room — still receiving its broadcasts and holding its seat).
 *
 * Ordering matters: events must be emitted to the room BEFORE `socket.leave()`,
 * otherwise the broadcast has no room to target (BUG-5).
 */
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";

export async function performRoomLeave(
  socket: Socket,
  context: AppContext,
  roomId: string,
): Promise<void> {
  const userId = String(socket.data.user.id);
  const {
    roomManager,
    clientManager,
    seatRepository,
    autoCloseService,
    userRoomRepository,
  } = context;

  // Close this client's mediasoup transports for the room being left. Must run
  // before clearClientRoom(), which wipes the client's transport tracking.
  const client = clientManager.getClient(socket.id);
  const cluster = roomManager.getRoom(roomId);
  if (client && cluster) {
    for (const [transportId] of client.transports) {
      try {
        const transport = cluster.getTransport(transportId);
        if (transport && !transport.closed) transport.close();
      } catch {
        // Worker may already be gone — nothing to clean up.
      }
    }
  }

  // EXECUTE
  const seatResult = await seatRepository.leaveSeat(roomId, userId);
  clientManager.clearClientRoom(socket.id);

  const [newCount] = await Promise.all([
    roomManager.state.adjustParticipantCount(roomId, -1),
    userRoomRepository.clearUserRoom(socket.data.user.id),
    autoCloseService.recordActivity(roomId),
  ]);

  // REACT — emit BEFORE socket.leave so members still receive it.
  // F-41: leaveSeat clears EVERY seat the user held; clear them all on clients.
  if (seatResult.success) {
    const cleared = seatResult.clearedSeatIndices ?? [seatResult.seatIndex];
    for (const seatIndex of cleared) {
      emitToRoom(
        socket,
        roomId,
        "seat:cleared",
        { seatIndex, userId: Number(userId) },
        context.cascadeRelay,
      );
    }
  }

  if (newCount !== null) {
    const isLive = newCount > 0;
    context.laravelClient
      .updateRoomStatus(roomId, {
        is_live: isLive,
        participant_count: newCount,
        hosting_region: isLive ? config.AWS_REGION : null,
        hosting_ip: isLive
          ? config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null
          : null,
        hosting_port: isLive ? config.PORT : null,
      })
      .catch((err) =>
        logger.error({ err, roomId }, "Laravel leave status update failed"),
      );
  }

  emitToRoom(
    socket,
    roomId,
    "room:userLeft",
    { userId: socket.data.user.id },
    context.cascadeRelay,
  );

  socket.leave(roomId);

  logger.debug(
    { roomId, userId, seatCleared: seatResult.success },
    "Room leave teardown complete",
  );
}
