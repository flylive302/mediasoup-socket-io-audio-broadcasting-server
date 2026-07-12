import type { Server as SocketServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";
import type { WorkerManager } from "@src/infrastructure/worker.manager.js";
import { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import { RoomStateRepository } from "./roomState.js";
import { LaravelClient } from "@src/integrations/laravelClient.js";
import { ActiveSpeakerDetector } from "@src/domains/media/activeSpeaker.js";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";
import { clearRoomOwner } from "@src/domains/seat/seat.owner.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { config } from "@src/config/index.js";
import type { CascadeCoordinator } from "@src/domains/cascade/cascade-coordinator.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import type { RoomRegistry } from "./room-registry.js";
import type { PresenceTracker } from "./presence-tracker.js";
import type { StatusCoalescer } from "./status-coalescer.js";
import type { RoomModeService } from "./mode/room-mode.service.js";
import { metrics } from "@src/infrastructure/metrics.js";
import type { ClientManager } from "@src/client/clientManager.js";
import { evictShrunkSeats } from "./seat-shrink-eviction.js";

export class RoomManager {
  private readonly rooms = new Map<string, RoomMediaCluster>();
  private readonly stateRepo: RoomStateRepository;

  // Track rooms being created to prevent race conditions
  private readonly creatingRooms = new Map<string, Promise<RoomMediaCluster>>();

  // Cascade services (late-bound after bootstrap)
  private cascadeCoordinator: CascadeCoordinator | null = null;
  private cascadeRelay: CascadeRelay | null = null;
  private roomRegistry: RoomRegistry | null = null;
  // realtime-01: reconciles each owned Room's advisory count + TTL on heartbeat.
  private presenceTracker: PresenceTracker | null = null;
  // realtime-08: evaluates each owned Room's interactive↔broadcast mode on heartbeat.
  private roomModeService: RoomModeService | null = null;
  // realtime-09: tear down a Room's HLS broadcast session when its cluster closes
  // locally. Late-bound callback (not the controller) to avoid an import cycle.
  private broadcastOnRoomClosed: ((roomId: string) => void) | null = null;

  // F-34: periodic CAS ownership heartbeat (short TTL is refreshed here so a
  // live-but-idle origin keeps its claim; a crashed origin's claim expires).
  private ownershipHeartbeat: NodeJS.Timeout | null = null;
  private static readonly OWNERSHIP_HEARTBEAT_MS = 30_000;

  constructor(
    private readonly workerManager: WorkerManager,
    private readonly redis: Redis,
    private readonly io: SocketServer,
    private readonly laravelClient: LaravelClient,
    private readonly statusCoalescer: StatusCoalescer,
    private readonly seatRepository?: SeatRepository,
  ) {
    this.stateRepo = new RoomStateRepository(redis);

    // Subscribe to worker death events to clean up orphaned rooms
    this.workerManager.setOnWorkerDied((pid) => this.handleWorkerDeath(pid));
  }

  // Getter for state repo
  get state() {
    return this.stateRepo;
  }

  /**
   * dj-talk-over/02: expose the late-bound cascade relay so callers outside
   * RoomManager (e.g. EventRouter's ejectMemberOnBlock) can broadcast
   * music-stop cascade-aware without RoomManager threading it through every
   * dependent's constructor.
   */
  getCascadeRelay(): CascadeRelay | null {
    return this.cascadeRelay;
  }

  /**
   * Late-bind cascade services after bootstrap.
   * Called from server.ts when CASCADE_ENABLED is true.
   */
  setCascadeServices(
    coordinator: CascadeCoordinator,
    relay: CascadeRelay,
  ): void {
    this.cascadeCoordinator = coordinator;
    this.cascadeRelay = relay;
  }

  /**
   * Late-bind the RoomRegistry so closeRoom can release the CAS ownership key.
   * Always called from server.ts (independent of CASCADE_ENABLED) — single-instance
   * deploys still claim and release ownership for safety.
   */
  setRoomRegistry(registry: RoomRegistry): void {
    this.roomRegistry = registry;
    this.startOwnershipHeartbeat();
  }

  /**
   * realtime-17: is THIS instance the CAS origin for `roomId`?
   *
   * Single source of truth for the "only the origin flips mode / runs FFmpeg"
   * rule: the ownership heartbeat gates `roomModeService.evaluate` on this, and
   * the BroadcastPublishController re-checks it before spawning a publisher. When
   * no RoomRegistry is wired (single-instance / pre-bootstrap), every instance is
   * trivially the origin → returns true so behaviour is unchanged.
   */
  async isOwner(roomId: string): Promise<boolean> {
    if (!this.roomRegistry) return true;
    return this.roomRegistry.isOwner(roomId, config.INSTANCE_ID);
  }

  /**
   * realtime-01: late-bind the PresenceTracker so the periodic heartbeat can
   * reconcile each owned Room's advisory participant integer to real socket
   * presence AND refresh its room:state TTL. The reconcile is what fixes both
   * the long-lived-low-churn TTL-expiry leak (Cause C) and the sticky
   * under-count drift (Cause B: an owned Room that truly emptied gets its
   * integer reset to 0, so the auto-close candidate filter can find it).
   */
  setPresenceTracker(tracker: PresenceTracker): void {
    this.presenceTracker = tracker;
    this.startOwnershipHeartbeat();
  }

  /**
   * realtime-08: late-bind the RoomModeService so the heartbeat can flip each
   * owned Room interactive↔broadcast at the Listener threshold (with hysteresis)
   * using the real presence count it already computed for the reconcile.
   */
  setRoomModeService(service: RoomModeService): void {
    this.roomModeService = service;
    this.startOwnershipHeartbeat();
  }

  /**
   * realtime-09: late-bind the broadcast cleanup hook. Called whenever a Room's
   * local cluster is torn down (close / cross-region eviction) so its FFmpeg HLS
   * publisher stops with it. Idempotent (no-op when the Room isn't publishing).
   */
  setBroadcastClosedHook(hook: (roomId: string) => void): void {
    this.broadcastOnRoomClosed = hook;
  }

  /**
   * F-34: every ~30s refresh the CAS ownership claim for every room hosted on
   * this instance. `refreshOwnership` is a no-op (Lua-guarded) for any room
   * this instance no longer owns, so iterating all local rooms is safe.
   */
  private startOwnershipHeartbeat(): void {
    if (this.ownershipHeartbeat) return;
    this.ownershipHeartbeat = setInterval(() => {
      if (this.rooms.size === 0) return;
      const registry = this.roomRegistry;
      const tracker = this.presenceTracker;
      const selfId = config.INSTANCE_ID;
      for (const roomId of this.rooms.keys()) {
        registry
          ?.refreshOwnership(roomId, selfId)
          .catch((err) =>
            logger.warn({ err, roomId }, "Ownership heartbeat refresh failed"),
          );
        // realtime-01: heal advisory count + refresh room:state TTL for owned
        // Rooms (Lua is update-if-exists, so a reconcile racing closeRoom's
        // delete() can never resurrect the key).
        tracker
          ?.reconcile(roomId)
          .then(async (present) => {
            // realtime-02: the reconcile awaited fetchSockets — closeRoom may have
            // finished (rooms.delete + forget) while it was in flight. If the Room
            // is gone, a submit here would re-buffer AFTER forget and flush a stale
            // is_live:true on the next window → phantom-live. Bail if it closed.
            if (!this.rooms.has(roomId)) return;
            // realtime-08: flip interactive↔broadcast at the Listener threshold
            // (with hysteresis) using the presence we just computed, and fold the
            // resulting mode into the SAME coalesced status update so Laravel
            // converges idempotently. Only meaningful while live; a 0-presence
            // Room is about to auto-close. evaluate awaited Redis — re-check the
            // Room still exists before submitting.
            // realtime-17: only the CAS origin evaluates/flips mode and drives
            // the broadcast publisher. Edge instances (which hold the Room via
            // the cascade edge cluster) reach here too, but must NOT flip — that
            // is the split-brain mode-flap. The ownership check is contained:
            // false-on-error keeps the gate on the safe (no-flip) side AND never
            // aborts the unconditional presence/TTL submit below.
            const owns =
              present > 0 ? await this.isOwner(roomId).catch(() => false) : false;
            // realtime-22: on the CAS origin only, release any seat whose reconnect
            // grace has expired (a disconnected speaker who never came back).
            // Owned-room gated so exactly one instance sweeps → no duplicate
            // seat:cleared. Fire-and-forget; a swept-empty room that closeRoom
            // deletes can't be resurrected (the Lua only HDELs existing fields).
            if (owns) {
              void this.sweepExpiredSeatReservations(roomId).catch((err) =>
                logger.warn({ err, roomId }, "Seat reservation sweep failed"),
              );
            }
            // realtime-17b: gate the broadcast flip on an actual speaker. Without
            // a resumed audio producer there is no HLS stream to serve, so a
            // promote would only hand listeners a master.m3u8 that 404s forever.
            const speakerCount =
              present > 0 && owns
                ? (this.rooms.get(roomId)?.getResumedAudioProducerCount() ?? 0)
                : 0;
            const mode =
              present > 0 && owns
                ? (await this.roomModeService?.evaluate(
                    roomId,
                    present,
                    speakerCount,
                  )) ?? undefined
                : undefined;
            if (!this.rooms.has(roomId)) return;
            // realtime-02: also refresh the Laravel-side activity TTL with a
            // COALESCED keep-alive, so a long-running (>24h) idle broadcast with
            // no join/leave churn stays correctly tracked rather than going
            // stale. Coalesced → at most one status POST per Room per window.
            this.statusCoalescer.submit(roomId, {
              is_live: present > 0,
              participant_count: present,
              ...(mode ? { mode } : {}),
              hosting_region: present > 0 ? config.AWS_REGION : null,
              hosting_ip:
                present > 0
                  ? config.PUBLIC_IP || config.MEDIASOUP_ANNOUNCED_IP || null
                  : null,
              hosting_port: present > 0 ? config.PORT : null,
            });
          })
          .catch((err) =>
            logger.warn(
              { err, roomId },
              "Presence reconcile on heartbeat failed",
            ),
          );
      }
    }, RoomManager.OWNERSHIP_HEARTBEAT_MS);
    // Don't keep the event loop (or tests) alive solely for the heartbeat.
    this.ownershipHeartbeat.unref?.();
  }

  /**
   * realtime-22: release seats whose reconnect grace window has expired. The
   * disconnected occupant never re-claimed within SEAT_RETENTION_GRACE_MS, so we
   * drop the held slot AND the ghost participant that was kept for seat rendering:
   * seat:cleared frees the slot, room:userLeft removes the avatar. Cascade-aware
   * (broadcastToRoom relays cross-region). Called from the ownership heartbeat on
   * the CAS origin only, so the emits fire exactly once.
   */
  private async sweepExpiredSeatReservations(roomId: string): Promise<void> {
    if (!this.seatRepository) return;
    const cleared = await this.seatRepository.sweepExpiredReservations(
      roomId,
      Date.now(),
      config.SEAT_RETENTION_GRACE_MS,
    );
    for (const { seatIndex, userId } of cleared) {
      broadcastToRoom(
        this.io,
        roomId,
        "seat:cleared",
        // reason:"grace" marks this DELAYED sweep release so clients can tell
        // it apart from an explicit leave/kick — the FE self-retake guard
        // (F-24) must only ever swallow grace clears, never a real leave.
        { seatIndex, userId, reason: "grace" },
        this.cascadeRelay,
      );
      broadcastToRoom(this.io, roomId, "room:userLeft", { userId }, this.cascadeRelay);
      logger.info(
        { roomId, seatIndex, userId },
        "Seat reservation expired — released via heartbeat sweep",
      );
    }
  }

  /**
   * room-seat-caps/02: evict every occupied seat >= newSeatCount after a live
   * shrink (room.updated sync). Delegates to seat-shrink-eviction.ts for the
   * atomic clear + producer-close + broadcast/targeted-emit sequence; no-ops
   * if seat persistence isn't wired (mirrors sweepExpiredSeatReservations).
   */
  async evictShrunkSeats(
    roomId: string,
    newSeatCount: number,
    clientManager: ClientManager,
  ): Promise<void> {
    if (!this.seatRepository) return;
    await evictShrunkSeats({
      roomId,
      newSeatCount,
      io: this.io,
      redis: this.redis,
      cascadeRelay: this.cascadeRelay,
      seatRepository: this.seatRepository,
      clientManager,
      getRoom: (id) => this.getRoom(id),
    });
  }

  /** Stop the ownership heartbeat — called during graceful shutdown. */
  stopOwnershipHeartbeat(): void {
    if (this.ownershipHeartbeat) {
      clearInterval(this.ownershipHeartbeat);
      this.ownershipHeartbeat = null;
    }
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  /**
   * F-2: keep the Prometheus rooms gauge in lockstep with the rooms map.
   * Called on every add/remove so it can never drift between scrapes.
   */
  private syncRoomGauge(): void {
    metrics.roomsActive.set(this.rooms.size);
  }

  /** Max listeners in any single room on this instance (for CloudWatch) */
  getMaxRoomListeners(): number {
    let max = 0;
    for (const cluster of this.rooms.values()) {
      const count = cluster.getListenerCount();
      if (count > max) max = count;
    }
    return max;
  }

  /**
   * Get or create a room.
   * If creating, initializes mediasoup router and Redis state.
   * Race condition safe: concurrent calls for same roomId coalesce.
   */
  async getOrCreateRoom(roomId: string): Promise<RoomMediaCluster> {
    // Check if room already exists
    let cluster = this.rooms.get(roomId);
    if (cluster) return cluster;

    // Check if room creation is already in progress
    let pending = this.creatingRooms.get(roomId);
    if (pending) return pending;

    // Start room creation and track the promise
    pending = this.doCreateRoom(roomId);
    this.creatingRooms.set(roomId, pending);

    try {
      cluster = await pending;
      return cluster;
    } finally {
      this.creatingRooms.delete(roomId);
    }
  }

  /**
   * Internal room creation logic (called only once per roomId)
   */
  private async doCreateRoom(roomId: string): Promise<RoomMediaCluster> {
    logger.info({ roomId }, "Creating new room");

    // 1. Create RoomMediaCluster (handles its own worker selection)
    const cluster = new RoomMediaCluster(this.workerManager, logger);
    await cluster.initialize();

    // 2. Setup Active Speaker Detector
    if (cluster.audioObserver) {
      const detector = new ActiveSpeakerDetector(
        cluster.audioObserver,
        roomId,
        this.io,
      );
      detector.start();
      cluster.setActiveSpeakerDetector(detector);
    }

    // F-33/F-36: do NOT register the cluster in `this.rooms` until Redis state
    // and Laravel are initialized. Registering early means a transient Redis or
    // Laravel failure leaves a permanently cached half-initialized "ghost room"
    // (no Redis state → never auto-closes; getOrCreateRoom fast-path keeps
    // returning the broken cluster). On any init failure we tear the cluster
    // down and release the CAS claim so the next join re-creates cleanly.
    try {
      // 3. Initialize State (source of truth for auto-close + participant count)
      await this.stateRepo.save({
        id: roomId,
        status: "ACTIVE",
        participantCount: 0,
        seatCount: 15, // BL-008: Default; updated when first joiner sends seatCount
        mode: "interactive", // realtime-08: every Room starts interactive; flips at the Listener threshold
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      // 4. Notify Laravel Live (including hosting info for cross-region cascade)
      await this.laravelClient.updateRoomStatus(roomId, {
        is_live: true,
        participant_count: 0,
        hosting_region: config.AWS_REGION,
        hosting_ip: config.PUBLIC_IP,
        hosting_port: config.PORT,
      });
    } catch (err) {
      logger.error(
        { err, roomId },
        "Room init failed after cluster create — tearing down to avoid ghost room",
      );
      await cluster
        .close()
        .catch((closeErr) =>
          logger.error(
            { err: closeErr, roomId },
            "Cluster close during ghost-room cleanup failed",
          ),
        );
      if (this.roomRegistry) {
        await this.roomRegistry
          .cleanup(roomId)
          .catch((rrErr) =>
            logger.error(
              { err: rrErr, roomId },
              "CAS release during ghost-room cleanup failed",
            ),
          );
      }
      throw err;
    }

    // 5. Only now is the room safe to serve — register it.
    this.rooms.set(roomId, cluster);
    this.syncRoomGauge();

    return cluster;
  }

  /**
   * Handle worker death: close all rooms that have the dead worker
   * in their cluster (source or distribution).
   * ARCH-002 FIX: Now async so WorkerManager can await cleanup before re-creating.
   */
  private async handleWorkerDeath(workerPid: number): Promise<void> {
    const orphanedRooms: string[] = [];

    for (const [roomId, cluster] of this.rooms) {
      const workerPids = cluster.getWorkerPids();
      if (workerPids.includes(workerPid)) {
        orphanedRooms.push(roomId);
      }
    }

    if (orphanedRooms.length === 0) return;

    logger.warn(
      { workerPid, roomCount: orphanedRooms.length, roomIds: orphanedRooms },
      "Cleaning up rooms from dead worker",
    );

    // Close all orphaned rooms concurrently and await completion
    const results = await Promise.allSettled(
      orphanedRooms.map((roomId) =>
        this.closeRoom(roomId, "worker_died").catch((err) => {
          logger.error(
            { err, roomId, workerPid },
            "Error closing orphaned room",
          );
          // Even if closeRoom fails, ensure we remove from local map
          this.rooms.delete(roomId);
          this.syncRoomGauge();
        }),
      ),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      logger.error(
        { workerPid, failed, total: orphanedRooms.length },
        "Some orphaned rooms failed to close",
      );
    }
  }

  /**
   * Close a room and cleanup all resources.
   */
  async closeRoom(roomId: string, reason = "host_left"): Promise<void> {
    const cluster = this.rooms.get(roomId);
    if (!cluster) {
      // realtime-08 (AC4): no local cluster — either the Room was already closed
      // here (state gone → reap is a no-op) or it's an ORPHAN whose owning
      // instance/region died. The auto-close poller on a surviving same-region
      // peer detects the orphan via shared Redis (presence 0 region-wide, after
      // grace), but closeRoom used to no-op for it — leaving Laravel is_live:true
      // and stale hosting info forever. Reap the shared state so the Room ends
      // cleanly and any still-connected clients are told.
      await this.reapOrphanedState(roomId, reason);
      return;
    }

    logger.info({ roomId, reason }, "Closing room");

    // realtime-09: stop the HLS broadcast publisher before the cluster (and its
    // plain transports) go away, so no orphaned FFmpeg keeps encoding.
    this.broadcastOnRoomClosed?.(roomId);
    // realtime-19: drop the demote-damping streak for the closed room (leak guard).
    this.roomModeService?.forget(roomId);

    // 1. Notify Frontend (local + cross-region)
    const closePayload = { roomId, reason, timestamp: Date.now() };
    this.io.to(roomId).emit("room:closed", closePayload);
    if (this.cascadeRelay?.hasRemotes(roomId)) {
      this.cascadeRelay
        .relayToRemote(roomId, "room:closed", closePayload)
        .catch((err) =>
          logger.error({ err, roomId }, "Failed to relay room close event"),
        );
    }

    // 2. Notify Laravel (fire-and-forget — don't block mediasoup cleanup on Laravel).
    // realtime-02: flushNow sends the close immediately AND drops any buffered
    // participant update for this Room, so a coalesced/heartbeat is_live:true
    // can't land after the close and resurrect a dead Room.
    this.statusCoalescer
      .flushNow(roomId, {
        is_live: false,
        participant_count: 0,
        ended_at: new Date().toISOString(),
        hosting_region: null,
        hosting_ip: null,
        hosting_port: null,
      })
      .catch((err) =>
        logger.error({ err, roomId }, "Laravel close status update failed"),
      );

    // 3. ROOM-ARCH-001 FIX: Parallelize independent cleanup operations
    const cleanupOps: Promise<void>[] = [
      cluster.close(),
      this.stateRepo.delete(roomId),
    ];
    if (this.seatRepository) {
      cleanupOps.push(this.seatRepository.clearRoom(roomId));
    }
    if (this.cascadeCoordinator) {
      cleanupOps.push(
        this.cascadeCoordinator
          .cleanup(roomId)
          .catch((err) =>
            logger.error({ err, roomId }, "Cascade cleanup failed"),
          ),
      );
    }
    // B-1: Release CAS ownership claim so another instance can re-claim if a
    // new room with this id appears later (e.g., user re-opens after closing).
    if (this.roomRegistry) {
      cleanupOps.push(
        this.roomRegistry
          .cleanup(roomId)
          .catch((err) =>
            logger.error({ err, roomId }, "RoomRegistry cleanup failed"),
          ),
      );
    }
    await Promise.all(cleanupOps);

    // SEAT-004 FIX: Clean up owner cache to prevent memory leak
    clearRoomOwner(roomId);
    // realtime-01: drop presence grace bookkeeping so the map can't leak.
    this.presenceTracker?.forget(roomId);

    this.rooms.delete(roomId);
    // realtime-02: the Room is now out of the map (no heartbeat can re-submit);
    // drop any status entry a heartbeat buffered mid-cleanup so the next window
    // tick can't flush a stale is_live:true for this closed Room.
    this.statusCoalescer.forget(roomId);
    this.syncRoomGauge();
  }

  /**
   * realtime-08 (AC4): reap the SHARED state of a Room this instance does not
   * host locally. Used when closeRoom is asked to close an orphan whose owning
   * instance/region died — there is no local cluster to tear down, only shared
   * Redis + Laravel state to clean up so the Room ends cleanly.
   *
   * Safe against false-reaping a live Room: the only caller path is the
   * auto-close poller, which already proved region-wide presence == 0 past the
   * grace window (a Room live on a sibling instance reads presence > 0 via the
   * region's Redis adapter, so it never becomes a candidate). Cross-region Rooms
   * live in a different region's Redis and are never SCANned here.
   *
   * No-op when the state key is already gone (the Room was closed normally), so
   * a redundant closeRoom on an already-closed Room costs one Redis GET.
   */
  private async reapOrphanedState(
    roomId: string,
    reason: string,
  ): Promise<void> {
    const state = await this.stateRepo.get(roomId);
    if (!state) return; // already gone — nothing to reap

    logger.warn(
      { roomId, reason },
      "Reaping orphaned room state (no local cluster — owning instance/region likely died)",
    );

    // Tell any clients still attached to this region (e.g. a reconnecter that
    // landed here) that the Room is gone, mirroring closeRoom's notification.
    this.io
      .to(roomId)
      .emit("room:closed", { roomId, reason, timestamp: Date.now() });

    // Mark Laravel not-live immediately AND drop any buffered participant update
    // so a coalesced is_live:true can't resurrect the dead Room (same contract
    // as closeRoom).
    await this.statusCoalescer
      .flushNow(roomId, {
        is_live: false,
        participant_count: 0,
        ended_at: new Date().toISOString(),
        hosting_region: null,
        hosting_ip: null,
        hosting_port: null,
      })
      .catch((err) =>
        logger.error(
          { err, roomId },
          "Laravel not-live update failed during orphan reap",
        ),
      );

    // NOTE: deliberately does NOT call roomRegistry.cleanup() here.
    // `cleanup` is an unconditional DEL of the CAS owner key (not delete-if-mine),
    // and this reap fires for a room this instance does not own. A genuine
    // orphan's owner key has already expired via its own short TTL
    // (OWNER_TTL_SECONDS=90s ≪ the 2-min activity window + grace that gates this
    // path), so there is nothing to release; deleting it would only risk wiping a
    // live sibling's fresh claim (split-brain surface). `claimOwnership` already
    // recovers a dead owner's key on the next re-open.
    const cleanupOps: Promise<void>[] = [this.stateRepo.delete(roomId)];
    if (this.seatRepository) {
      cleanupOps.push(this.seatRepository.clearRoom(roomId));
    }
    await Promise.all(cleanupOps);

    clearRoomOwner(roomId);
    this.presenceTracker?.forget(roomId);
    this.statusCoalescer.forget(roomId);
  }

  // ROOM-PERF-002 FIX: Synchronous — Map.get() has no async work
  getRoom(roomId: string): RoomMediaCluster | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Local-only eviction of a room's mediasoup cluster from this process.
   *
   * Unlike closeRoom(), this performs NO shared-state mutation: it does not emit
   * room:closed, does not notify Laravel, does not delete the shared room:state,
   * and — critically — does not release the CAS ownership key (which this
   * instance does not own for a ghost/edge room; releasing it would orphan the
   * real origin). Used to drop a stale/ghost cluster (e.g. an edge whose origin
   * closed but whose cluster was never removed) so a subsequent join re-runs
   * ownership resolution instead of being short-circuited by the leftover cluster.
   */
  async evictLocalRoom(roomId: string): Promise<void> {
    const cluster = this.rooms.get(roomId);
    if (!cluster) return;
    // Remove from the map first so a concurrent getRoom() can't hand out a
    // cluster that is mid-teardown.
    this.rooms.delete(roomId);
    this.presenceTracker?.forget(roomId);
    // realtime-17: this path deliberately does NOT release the CAS owner key
    // (it belongs to the real origin), but the cache-only entry for this room
    // must still be dropped so it can't leak across edge churn.
    this.roomRegistry?.forgetOwnerCache(roomId);
    // realtime-19: drop the demote-damping streak so it can't leak across edge churn.
    this.roomModeService?.forget(roomId);
    // realtime-09: stop any HLS publisher for this local cluster before it closes.
    this.broadcastOnRoomClosed?.(roomId);
    await cluster.close();
    this.syncRoomGauge();
    logger.info(
      { roomId },
      "Evicted local room cluster (ghost/edge — no shared-state mutation)",
    );
  }
}
