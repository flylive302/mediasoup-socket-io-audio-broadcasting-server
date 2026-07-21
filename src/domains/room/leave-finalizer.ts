/**
 * LeaveFinalizer — the ONE symmetric room-leave teardown (realtime-01).
 *
 * Used by BOTH the explicit `room:leave` path (via `performRoomLeave`) and the
 * `disconnect` path, so the backend is updated identically on every leave route
 * (fixes Cause A / H3: disconnect — the dominant mobile leave — previously never
 * told Laravel `is_live`/`participant_count`, leaving phantom-live Rooms).
 *
 * Presence-authoritative: the new participant count comes from real socket
 * membership (`PresenceTracker`), NOT a `-1` on the drift-prone integer. On the
 * disconnect path Socket.IO has already removed the socket from its rooms by the
 * time `disconnect` fires; on the explicit path we `socket.leave()` first — so
 * either way the leaver is excluded and both paths produce the same count.
 */
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { reactError } from "@src/shared/react-error.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";

export interface FinalizeLeaveOptions {
  /** True when invoked from the `disconnect` handler (socket already gone). */
  viaDisconnect: boolean;
}

/**
 * Tear down one client's membership of `roomId` and update the backend.
 * Returns the post-leave presence count, or null if the count could not be read.
 */
export async function finalizeLeave(
  socket: Socket,
  context: AppContext,
  roomId: string,
  options: FinalizeLeaveOptions,
): Promise<number | null> {
  const userId = socket.data.user.id;
  const {
    roomManager,
    clientManager,
    seatRepository,
    autoCloseService,
    userRoomRepository,
    presenceTracker,
    statusCoalescer,
    cascadeRelay,
  } = context;

  // Close this client's mediasoup transports for the Room. Must run before
  // clearClientRoom(), which wipes the client's transport tracking.
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

  // realtime-22 (reworked, seat-desync-self-heal): on a genuine socket death
  // (viaDisconnect) a seated user's slot is RESERVED in Redis for the reconnect
  // grace window — nobody else can take it, and a rejoin within grace re-seats
  // them — but to every client this is a normal, fully visible leave. No event
  // is ever suppressed: the roster (live sockets) and the rendered seats stay
  // consistent by construction, which is what the old "retain in place +
  // suppress seat:cleared/room:userLeft" design broke (ghost seats, roster/seat
  // snapshot skew). Reservation is gated to rooms this instance serves from its
  // own authoritative Redis (origin / single-instance): a cross-region edge's
  // local Redis is not the seat's source of truth. An explicit room:leave never
  // reserves.
  const reserveEligible =
    options.viaDisconnect &&
    !(context.cascadeCoordinator?.isEdgeRoom(roomId) ?? false);
  const reservedIndices = reserveEligible
    ? await seatRepository.reserveSeat(roomId, String(userId), Date.now())
    : [];
  const reserved = reservedIndices.length > 0;

  // EXECUTE — seat + client/user room teardown + activity (symmetric on both paths).
  // A reserved seat keeps its Redis entry (marked disconnectedAt) so seat:take
  // rejects others during grace; a non-reserved leave releases it outright.
  const seatResult = reserved
    ? ({ success: false, error: "" } as const)
    : await seatRepository.leaveSeat(roomId, String(userId));
  clientManager.clearClientRoom(socket.id);
  await Promise.all([
    userRoomRepository.clearUserRoom(userId),
    autoCloseService.recordActivity(roomId),
  ]);

  // REACT — emit BEFORE socket.leave so members still receive these. Always
  // emitted: clients render the leave immediately whether or not the seat is
  // silently reserved server-side.
  // F-41: leaveSeat clears EVERY seat the user held; clear them all on clients.
  const clearedIndices = reserved
    ? reservedIndices
    : seatResult.success
      ? (seatResult.clearedSeatIndices ?? [seatResult.seatIndex])
      : [];
  for (const seatIndex of clearedIndices) {
    emitToRoom(
      socket,
      roomId,
      "seat:cleared",
      { seatIndex, userId: Number(userId) },
      cascadeRelay,
    );
  }
  emitToRoom(socket, roomId, "room:userLeft", { userId }, cascadeRelay);

  // On disconnect the socket is already out of its rooms; this is a harmless
  // no-op there and the authoritative leave on the explicit path.
  socket.leave(roomId);

  // Presence-authoritative count (leaver now excluded), and heal the advisory
  // integer to it. THIS is the symmetric backend update both paths share.
  // realtime-02: coalesced — at most one status update per Room per window, so a
  // leave storm (e.g. mass disconnect) can no longer 429-flood Laravel. A truly
  // empty Room's is_live:false rides the same window; the actual Room teardown is
  // driven by AutoCloseEvaluator/closeRoom (which flushes immediately), not here.
  // msab-crash-drain 02: `reconcile` fans out over the Redis adapter and REJECTS
  // after `requestsTimeout` whenever a fleet peer is absent (mid-roll, crashed).
  // That rejection must not abort the leave — the teardown above is already
  // done, and the disconnect path's caller-side cleanup (unregisterSocket,
  // lifecycle hooks) still has to run. On failure: skip the status submit (the
  // ownership heartbeat re-reconciles owned Rooms ~30s later) and return null.
  let newCount: number | null = null;
  try {
    newCount = await presenceTracker.reconcile(roomId);
  } catch (err) {
    reactError(
      err,
      { roomId, userId },
      "Presence reconcile on leave failed — status update deferred to heartbeat",
      { logger },
    );
  }
  if (newCount !== null) {
    const isLive = newCount > 0;
    statusCoalescer.submit(roomId, {
      is_live: isLive,
      participant_count: newCount,
      hosting_region: isLive ? config.AWS_REGION : null,
      hosting_ip: isLive
        ? config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null
        : null,
      hosting_port: isLive ? config.PORT : null,
    });
  }

  logger.debug(
    {
      roomId,
      userId,
      viaDisconnect: options.viaDisconnect,
      newCount,
      seatCleared: seatResult.success || reserved,
      // realtime-22 (reworked): seat reserved in Redis for the grace window
      // (clients already saw it cleared; only seat:take is blocked).
      seatReserved: reserved,
      reservedSeatIndices: reserved ? reservedIndices : undefined,
    },
    "Room leave finalized",
  );

  return newCount;
}
