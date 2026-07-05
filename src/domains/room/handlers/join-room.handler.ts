/**
 * Handler for room:join event.
 *
 * Migrated to createHandler() for consistent validation, error handling,
 * and metrics. Uses GATE → EXECUTE → REACT pipeline separation.
 */
import {
  createHandler,
  type HandlerResult,
} from "@src/shared/handler.utils.js";
import { joinRoomSchema } from "@src/socket/schemas.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { setRoomOwner } from "@src/domains/seat/index.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { getMusicPlayerState } from "@src/domains/audio-player/index.js";
import { ActiveAppSlidesRepository } from "@src/domains/slide/index.js";
import { performRoomLeave } from "@src/domains/room/room-leave.js";
import { fetchSocketsSafe } from "@src/shared/fetch-sockets-safe.js";
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import type { z } from "zod";

type JoinPayload = z.input<typeof joinRoomSchema>;

/**
 * Resolve the local mediasoup cluster that will serve this join — origin (CAS
 * winner), cascade edge, or single-instance fallback. Extracted so the
 * snapshot-miss recovery (realtime-20) can re-run the FULL resolution after
 * detaching a stale edge. Throws if no cluster can be served.
 */
async function resolveClusterForJoin(
  roomId: string,
  context: AppContext,
): Promise<RoomMediaCluster> {
  const { roomManager, cascadeCoordinator, roomRegistry } = context;
  // selfId is INSTANCE_ID (identity, used for CAS ownership comparisons).
  const selfId = config.INSTANCE_ID;

  // Try to get/create the room locally first
  let cluster = roomManager.getRoom(roomId);

  // Ghost-cluster guard (same-region split-brain prevention). A pre-existing
  // local cluster is only legitimate if THIS instance owns the room via CAS
  // (origin) or is a registered cascade edge. A leftover cluster — e.g. an edge
  // whose origin closed but whose mediasoup cluster lingered in roomManager.rooms
  // — must NOT short-circuit the ownership/edge resolution below. Otherwise a
  // reconnect that the NLB routes to this instance is served on an orphaned
  // island: its room:userJoined / seat:updated broadcasts use .local + cascade
  // relay, and with no registered relay peer they reach NOBODY on the real
  // origin (the reconnecting user becomes invisible to everyone else while still
  // seeing them via the adapter-backed join snapshot). Drop the ghost and let the
  // CAS/edge path re-resolve ownership cleanly.
  if (cluster && roomRegistry) {
    const owner = await roomRegistry.getOwner(roomId);
    const ownedByMe = owner === selfId;
    const isRegisteredEdge = cascadeCoordinator?.isEdgeRoom(roomId) ?? false;
    if (!ownedByMe && !isRegisteredEdge) {
      logger.warn(
        { roomId, owner, selfId },
        "Evicting ghost room cluster (no valid ownership) before join",
      );
      await roomManager.evictLocalRoom(roomId);
      cluster = undefined;
    }
  }

  // Cross-Region Cascade Check (Laravel-discovered, between regions)
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

  // B-1: Same-region ownership via Redis CAS.
  // Without this, two instances in the same region could both fall through to
  // getOrCreateRoom() and end up running independent mediasoup routers for the
  // same room — producers on instance A unreachable to listeners on instance B.
  //
  // The registry's `ip` field is PUBLIC_IP (reachability, used by edges to
  // construct the origin's base URL); selfId (INSTANCE_ID, defined above) is
  // identity for CAS comparisons. These were the same value historically; they
  // are intentionally distinct now.
  if (!cluster && roomRegistry) {
    const claim = await roomRegistry.claimOwnership(roomId, selfId);

    if (claim.won || claim.owner === selfId) {
      // We own the room (just claimed, or already owned but lost local cluster
      // after restart). Become origin.
      cluster = await roomManager.getOrCreateRoom(roomId);
      await roomRegistry.registerOrigin(roomId, {
        instanceId: selfId,
        ip: config.PUBLIC_IP,
        port: config.PORT,
        listenerCount: 0,
      });
      logger.info({ roomId, selfId }, "Origin claimed via Redis CAS");
    } else if (cascadeCoordinator) {
      // Another instance in our region owns the room. Become an edge piping
      // from them. waitForOriginInfo handles the owner-init race.
      const edgeResult = await cascadeCoordinator.handleSameRegionEdge(
        roomId,
        claim.owner,
      );
      if (edgeResult.isEdge) {
        cluster = await roomManager.getOrCreateRoom(roomId);
        logger.info(
          { roomId, ownerInstanceId: claim.owner },
          "Edge room created for same-region cascade",
        );
      }
    }
  }

  // Fallback for single-instance / cascade-disabled deployments.
  // Also catches the path where roomRegistry was injected but cascade is off
  // and we lost CAS — there's no edge path available, so we surface the error
  // by leaving cluster null → we throw below.
  if (!cluster && !roomRegistry) {
    cluster = await roomManager.getOrCreateRoom(roomId);
  }

  if (!cluster) {
    throw new Error(
      `Cannot serve room ${roomId}: another instance owns it but cascade edge setup failed`,
    );
  }

  return cluster;
}

/**
 * Edge-only: fetch the origin's producers (piped), participants, and seat/music
 * snapshot in one round. `originUnreachable` flags a dead/relocated origin —
 * BOTH the participants and snapshot endpoints failing (AbortError on a dead
 * host, or 404 after the room moved). A single transient miss won't trip it.
 */
async function fetchEdgeOriginData(
  cascadeCoordinator: NonNullable<AppContext["cascadeCoordinator"]>,
  roomId: string,
  cluster: RoomMediaCluster,
  seatCount: number,
) {
  const [piped, originParticipants, snapshot] = await Promise.all([
    cascadeCoordinator.fetchAndPipeExistingProducers(roomId, cluster),
    cascadeCoordinator.fetchOriginParticipants(roomId),
    cascadeCoordinator.fetchOriginRoomSnapshot(roomId, seatCount),
  ]);
  const originUnreachable = snapshot === null && originParticipants === null;
  return { piped, originParticipants, snapshot, originUnreachable };
}

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
    roomRegistry,
  } = context;

  // selfId is INSTANCE_ID (identity, used for CAS ownership comparisons).
  const selfId = config.INSTANCE_ID;

  let cluster = await resolveClusterForJoin(roomId, context);

  // Refresh ownership TTL on every join so long-running celebrity broadcasts
  // don't hit the 24h orphan window. No-op (via Lua check) if we're not the owner.
  if (roomRegistry) {
    roomRegistry
      .refreshOwnership(roomId, selfId)
      .catch((err) =>
        logger.warn({ err, roomId }, "Failed to refresh room ownership TTL"),
      );
  }

  // NOTE: rtpCapabilities is captured AFTER the edge snapshot block — the
  // realtime-20 recovery may swap `cluster` (detach stale edge → re-resolve as
  // origin), and the response must carry the FINAL cluster's router caps.

  // Cache room owner if provided
  if (ownerId) {
    setRoomOwner(roomId, String(ownerId));
  }

  // F-31: if this socket is still a member of a DIFFERENT room (room switch
  // without an explicit room:leave), tear that prior room down first —
  // otherwise the user stays a ghost member: still in the old Socket.IO room,
  // still holding its seat, its participant count never decremented.
  const userId = socket.data.user.id;
  const priorRoomId = clientManager.getClient(socket.id)?.roomId;
  if (priorRoomId && priorRoomId !== roomId) {
    logger.info(
      { socketId: socket.id, userId, priorRoomId, roomId },
      "Room switch detected — leaving prior room before join",
    );
    await performRoomLeave(socket, context, priorRoomId);
  }

  // Update client room index
  clientManager.setClientRoom(socket.id, roomId);

  // realtime-22: re-claim a seat held through the reconnect grace window. If this
  // user's slot still carries a live disconnectedAt marker (set by finalizeLeave on
  // a genuine disconnect), clear it now so the ownership-heartbeat sweep won't
  // expire it — the seat is already carried in the snapshot below (it was never
  // released), so the reclaimer lands back in their exact slot with no flicker. A
  // slot reassigned during the outage no longer matches this user, so reclaim
  // yields and they join as a listener (no double-occupancy). Runs BEFORE the edge
  // snapshot fetch so the origin's HTTP snapshot (same-region shared Redis) already
  // reflects the cleared marker; a no-op for cross-region edges whose seats live in
  // the origin's Redis (those users were never retained — see finalizeLeave).
  const reclaim = await seatRepository.reclaimSeat(
    roomId,
    String(userId),
    Date.now(),
    config.SEAT_RETENTION_GRACE_MS,
  );
  if (reclaim.reclaimed) {
    logger.info(
      { roomId, userId, seatIndex: reclaim.seatIndex },
      "Seat re-claimed on rejoin within grace window",
    );
  }
  // NOTE: room:userJoined is broadcast normally on reclaim (below), NOT suppressed.
  // It serves two populations at once: clients that retained the user (userLeft was
  // suppressed) already have them — they de-dupe the upsert and skip the entry
  // animation via the FE "already-present" guard; clients that joined DURING the
  // grace window never saw the user (built from live sockets) yet see their held
  // seat, so they NEED this event to resolve that seat's placeholder. Suppressing
  // it would strand those late joiners with a permanent nameless seat.

  // BUG-1 FIX: Use fetchSockets() to discover participants across ALL instances
  // sharing the same Redis adapter, not just the local process.
  // This replaces the old clientManager.getClientsInRoom() which was in-memory only.
  // realtime-20: via fetchSocketsSafe so a ghost adapter subscriber degrades the
  // snapshot to local-only instead of throwing and failing the entire join.
  const remoteSockets = await fetchSocketsSafe(io, roomId, logger);
  const participants: {
    id: number;
    name: string;
    signature: string;
    avatar: string;
    frame_id: number | null;
    chat_bubble_id: number | null;
    entry_animation_id: number | null;
    data_card_id: number | null;
    mice_wave_id: number | null;
    slides_id: number | null;
    gender: number;
    country: string;
    wealth_xp: string;
    charm_xp: string;
    vip_level: number;
    date_of_birth: string | null;
    isSpeaker: boolean;
    equipped_badges?: {
      slot_position: number;
      badge_id: number;
      image_url: string | null;
    }[];
  }[] = [];
  const existingProducers: { producerId: string; userId: number }[] = [];

  // Deduplicate by userId (same user may have stale sockets across instances)
  const seenUserIds = new Set<number>();

  for (const rs of remoteSockets) {
    const remoteUser = rs.data?.user;
    if (!remoteUser || rs.id === socket.id) continue;
    if (seenUserIds.has(remoteUser.id)) continue;
    seenUserIds.add(remoteUser.id);

    participants.push({
      id: remoteUser.id,
      name: remoteUser.name,
      signature: remoteUser.signature,
      avatar: remoteUser.avatar,
      frame_id: remoteUser.frame_id,
      chat_bubble_id: remoteUser.chat_bubble_id,
      entry_animation_id: remoteUser.entry_animation_id,
      data_card_id: remoteUser.data_card_id,
      mice_wave_id: remoteUser.mice_wave_id,
      slides_id: remoteUser.slides_id,
      gender: remoteUser.gender,
      country: remoteUser.country,
      wealth_xp: remoteUser.wealth_xp,
      charm_xp: remoteUser.charm_xp,
      vip_level: remoteUser.vip_level ?? 0,
      date_of_birth: remoteUser.date_of_birth ?? null,
      isSpeaker: false, // Will be updated below from local clientManager
      equipped_badges: remoteUser.equipped_badges,
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

  // B-1 Stage 2d: edges have no local speakers — the producers actually live
  // on the origin. Fetch the origin's producer list and pipe each one so the
  // joining listener can consume against EDGE-LOCAL producer IDs. Replace
  // (don't merge) because the loop above only sees edge-local clients, none
  // of whom can be speakers without bidirectional piping.
  //
  // B-1 Stage 2j: also fetch the origin's participants so the edge user's
  // join response shows the full room, not just same-region sockets. Without
  // this, cross-region rooms appear empty until other-region users move
  // (relay-driven room:userJoined).
  //
  // B-1 Stage 2k: snapshot of origin's seat + music state for the same
  // reason — Redis is per-region.
  let originSnapshot: Awaited<
    ReturnType<
      NonNullable<typeof cascadeCoordinator>["fetchOriginRoomSnapshot"]
    >
  > | null = null;
  if (cascadeCoordinator?.isEdgeRoom(roomId)) {
    let edge: Awaited<ReturnType<typeof fetchEdgeOriginData>> | null =
      await fetchEdgeOriginData(cascadeCoordinator, roomId, cluster, seatCount);

    // realtime-20: a cached edge whose origin is unreachable (host hard-killed
    // before drain → never relayed room:closed, so this edge was never torn
    // down; or origin relocated) must NOT serve a broken degraded join. The
    // ghost-guard above can't catch it (isEdgeRoom is true) and the snapshot
    // fetches just blackhole on the dead IP. Detach the stale edge and re-run
    // the FULL resolution once: the dead origin's CAS key has expired (≤90s) so
    // this instance claims origin locally and heals, or re-attaches to the
    // origin's live new host. Bounded to a single retry — never loops.
    if (edge.originUnreachable) {
      logger.warn(
        { roomId, selfId },
        "Edge origin unreachable on join — detaching stale edge and re-resolving",
      );
      await cascadeCoordinator.handleOriginClosed(roomId);
      cluster = await resolveClusterForJoin(roomId, context);

      if (cascadeCoordinator.isEdgeRoom(roomId)) {
        // Re-resolved to a (live) origin elsewhere — fetch once more. If it
        // still fails we degrade to empty/local below rather than retry again.
        edge = await fetchEdgeOriginData(
          cascadeCoordinator,
          roomId,
          cluster,
          seatCount,
        );
      } else {
        // Became origin locally (CAS claim) — no edge snapshot to apply; local
        // participants/seats (built above + below) are now authoritative.
        edge = null;
      }
    }

    if (edge) {
      originSnapshot = edge.snapshot;

      // B-1 Stage 2d: edges have no local speakers — replace existingProducers
      // with the producers we just piped from the origin.
      existingProducers.length = 0;
      existingProducers.push(...edge.piped);

      // Merge origin's participants in, deduping by userId. Origin is the
      // authoritative source for cross-region users — local participants[]
      // here only carries same-region sockets that fetchSockets() saw.
      if (edge.originParticipants) {
        for (const op of edge.originParticipants) {
          if (op.id === userId) continue; // never add the joining user
          if (participantMap.has(op.id)) continue;
          participants.push(op);
          participantMap.set(op.id, op);
        }
      }

      // Mark participants whose producers we just piped as speakers so the UI
      // shows the right state for pre-existing speakers on edge join.
      for (const p of edge.piped) {
        const participant = participantMap.get(p.userId);
        if (participant) participant.isSpeaker = true;
      }
    }
  }

  // Captured here (not earlier): the realtime-20 recovery may have swapped
  // `cluster`, so the response must reflect the FINAL cluster's router caps.
  const rtpCapabilities = cluster.router?.rtpCapabilities;

  // Get seat data — origin's snapshot wins for edges (origin's Redis is
  // authoritative; local Redis only holds same-region writes).
  let seats: { seatIndex: number; userId: number; isMuted: boolean }[];
  let lockedSeats: number[];
  if (originSnapshot) {
    seats = originSnapshot.seats;
    lockedSeats = originSnapshot.lockedSeats;
  } else {
    const roomSeatsData = await seatRepository.getSeats(roomId, seatCount);
    lockedSeats = roomSeatsData.filter((s) => s.locked).map((s) => s.index);
    seats = [];
    for (const seatData of roomSeatsData) {
      if (seatData.userId) {
        seats.push({
          seatIndex: seatData.index,
          userId: Number(seatData.userId),
          isMuted: seatData.muted,
        });
      }
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
  const [newCount, , , localMusicPlayer] = await Promise.all([
    roomManager.state.adjustParticipantCount(roomId, 1),
    context.autoCloseService.recordActivity(roomId),
    context.userRoomRepository.setUserRoom(userId, roomId),
    getMusicPlayerState(context.redis, roomId),
  ]);

  // Origin's musicPlayer state wins for edges (per-region Redis again).
  const musicPlayer = originSnapshot
    ? originSnapshot.musicPlayer
    : localMusicPlayer;

  // Late-joiner replay: any app-scope slide still inside its window plays for
  // this joiner too (app slides show in *every* live room). Failure is
  // non-fatal — a missed slide must never block the join.
  const activeAppSlides = await new ActiveAppSlidesRepository(context.redis)
    .getActive()
    .catch(() => [] as unknown[]);

  return {
    rtpCapabilities,
    participants,
    seats,
    lockedSeats,
    existingProducers,
    musicPlayer,
    activeAppSlides,
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

  // realtime-02: coalesce the join churn — buffer the latest status; at most one
  // update per Room per window reaches Laravel (was a direct fire-and-forget POST
  // on every join, which flooded the shared internal rate limiter under load).
  if (result.newCount !== null) {
    context.statusCoalescer.submit(roomId, {
      is_live: true,
      participant_count: result.newCount,
      hosting_region: config.AWS_REGION,
      hosting_ip: config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null,
      hosting_port: config.PORT,
    });
  }

  // Broadcast to room (cascade-aware)
  const u = socket.data.user;
  emitToRoom(
    socket,
    roomId,
    "room:userJoined",
    {
      userId: u.id,
      user: {
        id: u.id,
        name: u.name,
        signature: u.signature,
        avatar: u.avatar,
        frame_id: u.frame_id,
        chat_bubble_id: u.chat_bubble_id,
        entry_animation_id: u.entry_animation_id,
        data_card_id: u.data_card_id,
        mice_wave_id: u.mice_wave_id,
        slides_id: u.slides_id,
        gender: u.gender,
        country: u.country,
        wealth_xp: u.wealth_xp,
        charm_xp: u.charm_xp,
        vip_level: u.vip_level ?? 0,
        date_of_birth: u.date_of_birth ?? null,
        equipped_badges: u.equipped_badges ?? [],
      },
    },
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
      activeAppSlides: result.activeAppSlides,
    } as HandlerResult;
  },
);
