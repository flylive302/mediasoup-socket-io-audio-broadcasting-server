/**
 * Seat Eviction (shrink) — room-seat-caps/02
 *
 * When `room.updated` lowers a room's seatCount, plainly evict every occupied
 * seat at index >= the new count: close the displaced user's audio producer
 * (mirrors seat:lock's kick path), broadcast the standard `seat:cleared` to
 * the room, and emit a targeted `seat:evicted` to just that user's
 * room-scoped sockets. Evicted users stay in the room as listeners and can
 * immediately re-take any free seat — no compaction, no forced disconnect.
 *
 * The Lua clear (SHRINK_EVICT_SCRIPT, see seat.lua-scripts.ts) is atomic in
 * isolation — one EVALSHA scans + HDELs every seat >= newSeatCount — but it
 * runs as a SEPARATE step AFTER RoomState.seatCount is saved, not inside the
 * same script as the count write (RoomState lives in a different Redis key
 * than the seats hash TAKE_SEAT_SCRIPT bounds-checks against). That leaves a
 * narrow stale-read window: a take-seat handler that read the OLD (higher)
 * seatCount before the save can still land a HSET on an index >= the new
 * count AFTER this scan has already run, producing a ghost seat this pass
 * does not catch. Closing that fully would require TAKE_SEAT_SCRIPT/
 * ASSIGN_SEAT_SCRIPT to read seatCount in-Lua from a Redis-backed key the
 * shrink updates atomically, instead of trusting the caller's ARGV — out of
 * scope here; flagged for a follow-up if the race proves to matter in
 * practice (it requires a take to be in-flight at the exact moment of an
 * owner-triggered shrink).
 *
 * Grow path never calls this module — no eviction, no events.
 */
import type { Server as SocketServer } from "socket.io";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";
import type { ClientManager } from "@src/client/clientManager.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { logger } from "@src/infrastructure/logger.js";

export interface EvictShrunkSeatsParams {
  roomId: string;
  newSeatCount: number;
  io: SocketServer;
  cascadeRelay: CascadeRelay | null;
  seatRepository: SeatRepository;
  clientManager: ClientManager;
  getRoom: (roomId: string) => RoomMediaCluster | undefined;
}

/**
 * EXECUTE + REACT: atomically clear seats >= newSeatCount, close each
 * displaced user's producer, and broadcast/target the resulting events.
 * Never throws — internal failures are logged and swallowed (REACT).
 */
export async function evictShrunkSeats(params: EvictShrunkSeatsParams): Promise<void> {
  const { roomId, newSeatCount, io, cascadeRelay, seatRepository, clientManager, getRoom } =
    params;

  const evicted = await seatRepository.evictSeatsAboveCount(roomId, newSeatCount);
  if (evicted.length === 0) return;

  for (const { seatIndex, userId } of evicted) {
    closeDisplacedProducer(roomId, userId, clientManager, getRoom);

    // Standard room-wide seat-cleared, tagged so the FE's own-seat toast/teardown
    // (which already fires on any seat:cleared for the current user) yields to
    // the eviction-specific targeted toast below instead of double-firing.
    broadcastToRoom(
      io,
      roomId,
      "seat:cleared",
      { seatIndex, userId, reason: "shrink" },
      cascadeRelay,
    );

    const socketIds = clientManager.getSocketIdsByUserInRoom(userId, roomId);
    if (socketIds.length > 0) {
      io.to(socketIds).emit("seat:evicted", { roomId, seatIndex, newSeatCount });
    }

    logger.info({ roomId, seatIndex, userId, newSeatCount }, "Seat evicted on shrink");
  }
}

/**
 * Server-side producer close — mirrors seat:lock's kick path (lock-seat.handler.ts),
 * including the F-45 ownership guard: verify the producer still belongs to the
 * displaced user before closing (a rapid disconnect→reconnect→produce could
 * otherwise close a brand-new unrelated producer).
 */
function closeDisplacedProducer(
  roomId: string,
  userId: number,
  clientManager: ClientManager,
  getRoom: (roomId: string) => RoomMediaCluster | undefined,
): void {
  const client = clientManager
    .getClientsInRoom(roomId)
    .find((c) => String(c.userId) === String(userId));
  if (!client) return;

  const audioProducerId = client.producers.get("audio");
  if (!audioProducerId) return;

  const room = getRoom(roomId);
  const producer = room?.getProducer(audioProducerId);
  if (producer && !producer.closed) {
    if (producer.appData.userId === userId) {
      producer.close();
      logger.info(
        { roomId, producerId: audioProducerId, userId },
        "Producer closed (seat evicted on shrink)",
      );
    } else {
      logger.warn(
        {
          roomId,
          producerId: audioProducerId,
          userId,
          producerUserId: producer.appData.userId,
        },
        "Skipped producer close on shrink eviction — producer no longer owned by displaced user",
      );
    }
  }

  client.producers.delete("audio");
  client.isSpeaker = client.producers.size > 0;
}
