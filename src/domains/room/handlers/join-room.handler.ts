/**
 * Handler for room:join event.
 *
 * Migrated to createHandler() for consistent validation, error handling,
 * and metrics. Uses GATE → EXECUTE → REACT pipeline separation.
 */
import { createHandler, type HandlerResult } from "@src/shared/handler.utils.js";
import { joinRoomSchema } from "@src/socket/schemas.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { setRoomOwner } from "@src/domains/seat/index.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { getMusicPlayerState } from "@src/domains/audio-player/index.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import type { z } from "zod";

type JoinPayload = z.input<typeof joinRoomSchema>;

// ── EXECUTE ─────────────────────────────────────────────────
async function processJoin(
  payload: JoinPayload,
  socket: Socket,
  context: AppContext,
) {
  const { roomId, ownerId } = payload;
  const seatCount = payload.seatCount ?? 15;
  const {
    io,
    roomManager,
    clientManager,
    seatRepository,
    cascadeCoordinator,
  } = context;

  // Try to get/create the room locally first
  let cluster = roomManager.getRoom(roomId);

  // Cross-Region Cascade Check
  if (!cluster && cascadeCoordinator) {
    const cascadeResult =
      await cascadeCoordinator.handleCrossRegionJoin(roomId);
    if (cascadeResult.isEdge) {
      cluster = await roomManager.getOrCreateRoom(roomId);
      logger.info(
        {
          roomId,
          originRegion: cascadeResult.originRegion,
          originIp: cascadeResult.originIp,
        },
        "Edge room created for cross-region cascade",
      );
    }
  }

  // Standard flow: create room if still not found (we're the origin)
  if (!cluster) {
    cluster = await roomManager.getOrCreateRoom(roomId);
  }

  const rtpCapabilities = cluster.router?.rtpCapabilities;

  // Cache room owner if provided
  if (ownerId) {
    setRoomOwner(roomId, String(ownerId));
  }

  // Update client room index
  const userId = socket.data.user.id;
  clientManager.setClientRoom(socket.id, roomId);

  // BUG-1 FIX: Use fetchSockets() to discover participants across ALL instances
  // sharing the same Redis adapter, not just the local process.
  // This replaces the old clientManager.getClientsInRoom() which was in-memory only.
  const remoteSockets = await io.in(roomId).fetchSockets();
  const participants: {
    id: number;
    name: string;
    signature: string;
    avatar: string;
    frame: string;
    gender: number;
    country: string;
    wealth_xp: string;
    charm_xp: string;
    vip_level: number;
    isSpeaker: boolean;
  }[] = [];
  const existingProducers: { producerId: string; userId: number }[] = [];

  // Deduplicate by userId (same user may have stale sockets across instances)
  const seenUserIds = new Set<number>();

  for (const rs of remoteSockets) {
    const remoteUser = rs.data?.user;
    if (!remoteUser || rs.id === socket.id) continue;
    if (seenUserIds.has(remoteUser.id)) continue;
    seenUserIds.add(remoteUser.id);

    // B-1 FIX: Only include visual/identity fields — exclude PII (phone, email, date_of_birth)
    participants.push({
      id: remoteUser.id,
      name: remoteUser.name,
      signature: remoteUser.signature,
      avatar: remoteUser.avatar,
      frame: remoteUser.frame,
      gender: remoteUser.gender,
      country: remoteUser.country,
      wealth_xp: remoteUser.wealth_xp,
      charm_xp: remoteUser.charm_xp,
      vip_level: remoteUser.vip_level ?? 0,
      isSpeaker: false, // Will be updated below from local clientManager
    });
  }

  // Producer tracking remains local — mediasoup producers only exist on the local instance
  // P-2 FIX: Build Map for O(1) participant lookup (was O(n²) with .find() in loop)
  const participantMap = new Map(participants.map((p) => [p.id, p]));
  const allLocalClients = clientManager.getClientsInRoom(roomId);
  for (const c of allLocalClients) {
    if (c.socketId === socket.id) continue;

    // BUG-2 FIX: Only verify local sockets (remote ones are validated by fetchSockets)
    const clientSocket = io.sockets.sockets.get(c.socketId);
    if (!clientSocket?.connected) {
      logger.warn(
        { socketId: c.socketId, userId: c.userId, roomId },
        "Removing stale local client",
      );
      clientManager.removeClient(c.socketId);
      continue;
    }

    // Update isSpeaker for local participants
    const participant = participantMap.get(c.userId);
    if (participant) {
      participant.isSpeaker = c.isSpeaker;
    }

    const audioProducerId = c.producers.get("audio");
    if (audioProducerId) {
      existingProducers.push({ producerId: audioProducerId, userId: c.userId });
    }
  }

  // Get seat data
  const roomSeatsData = await seatRepository.getSeats(roomId, seatCount);
  const lockedSeats = roomSeatsData.filter((s) => s.locked).map((s) => s.index);
  const seats: { seatIndex: number; userId: number; isMuted: boolean }[] = [];
  for (const seatData of roomSeatsData) {
    if (seatData.userId) {
      seats.push({
        seatIndex: seatData.index,
        userId: Number(seatData.userId),
        isMuted: seatData.muted,
      });
    }
  }

  // Join socket room
  socket.join(roomId);

  // Sync seatCount from frontend to Redis state
  // NOTE: Must run BEFORE adjustParticipantCount since both operate on the same
  // room:state key. Running in parallel would cause save() to overwrite the
  // adjusted participant count (lost-update race).
  const state = await roomManager.state.get(roomId);
  if (state && state.seatCount !== seatCount) {
    state.seatCount = seatCount;
    await roomManager.state.save(state);
  }

  // Parallel Redis operations (safe — these use different Redis keys)
  const [newCount, , , musicPlayer] = await Promise.all([
    roomManager.state.adjustParticipantCount(roomId, 1),
    context.autoCloseService.recordActivity(roomId),
    context.userRoomRepository.setUserRoom(userId, roomId),
    getMusicPlayerState(context.redis, roomId),
  ]);

  return {
    rtpCapabilities,
    participants,
    seats,
    lockedSeats,
    existingProducers,
    musicPlayer,
    newCount,
    userId,
  };
}

// ── REACT ───────────────────────────────────────────────────
function afterJoin(
  result: Awaited<ReturnType<typeof processJoin>>,
  payload: JoinPayload,
  socket: Socket,
  context: AppContext,
) {
  const { roomId } = payload;

  // Laravel update is fire-and-forget
  if (result.newCount !== null) {
    context.laravelClient
      .updateRoomStatus(roomId, {
        is_live: true,
        participant_count: result.newCount,
        hosting_region: config.AWS_REGION,
        hosting_ip:
          config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null,
        hosting_port: config.PORT,
      })
      .catch((err) =>
        logger.error({ err, roomId }, "Laravel status update failed"),
      );
  }

  // Broadcast to room (cascade-aware)
  emitToRoom(
    socket,
    roomId,
    "room:userJoined",
    { userId: socket.data.user.id, user: socket.data.user },
    context.cascadeRelay,
  );

  logger.info(
    {
      roomId,
      userId: result.userId,
      participantCount: result.participants.length,
      seatCount: result.seats.length,
      lockedSeatsCount: result.lockedSeats.length,
      producerCount: result.existingProducers.length,
    },
    "Sending initial room state",
  );
}

// ── Exported Handler ────────────────────────────────────────
export const joinRoomHandler = createHandler(
  "room:join",
  joinRoomSchema,
  async (payload, socket, context): Promise<HandlerResult> => {
    // EXECUTE
    const result = await processJoin(payload, socket, context);

    // REACT
    afterJoin(result, payload, socket, context);

    // Return flat — frontend reads response.rtpCapabilities directly
    return {
      success: true,
      rtpCapabilities: result.rtpCapabilities,
      participants: result.participants,
      seats: result.seats,
      lockedSeats: result.lockedSeats,
      existingProducers: result.existingProducers,
      musicPlayer: result.musicPlayer,
    } as HandlerResult;
  },
);
