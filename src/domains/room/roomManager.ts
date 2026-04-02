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
import { config } from "@src/config/index.js";
import type { CascadeCoordinator } from "@src/domains/cascade/cascade-coordinator.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";

export class RoomManager {
  private readonly rooms = new Map<string, RoomMediaCluster>();
  private readonly stateRepo: RoomStateRepository;

  // Track rooms being created to prevent race conditions
  private readonly creatingRooms = new Map<string, Promise<RoomMediaCluster>>();

  // Cascade services (late-bound after bootstrap)
  private cascadeCoordinator: CascadeCoordinator | null = null;
  private cascadeRelay: CascadeRelay | null = null;

  constructor(
    private readonly workerManager: WorkerManager,
    redis: Redis,
    private readonly io: SocketServer,
    private readonly laravelClient: LaravelClient,
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
   * Late-bind cascade services after bootstrap.
   * Called from server.ts when CASCADE_ENABLED is true.
   */
  setCascadeServices(coordinator: CascadeCoordinator, relay: CascadeRelay): void {
    this.cascadeCoordinator = coordinator;
    this.cascadeRelay = relay;
  }

  getRoomCount(): number {
    return this.rooms.size;
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

    this.rooms.set(roomId, cluster);

    // 3. Initialize State
    await this.stateRepo.save({
      id: roomId,
      status: "ACTIVE",
      participantCount: 0,
      seatCount: 15, // BL-008: Default; updated when first joiner sends seatCount
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
          logger.error({ err, roomId, workerPid }, "Error closing orphaned room");
          // Even if closeRoom fails, ensure we remove from local map
          this.rooms.delete(roomId);
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
    if (!cluster) return;

    logger.info({ roomId, reason }, "Closing room");

    // 1. Notify Frontend (local + cross-region)
    const closePayload = { roomId, reason, timestamp: Date.now() };
    this.io.to(roomId).emit("room:closed", closePayload);
    if (this.cascadeRelay?.hasRemotes(roomId)) {
      this.cascadeRelay
        .relayToRemote(roomId, "room:closed", closePayload)
        .catch((err) => logger.error({ err, roomId }, "Failed to relay room close event"));
    }

    // 2. Notify Laravel (fire-and-forget — don't block mediasoup cleanup on Laravel)
    this.laravelClient
      .updateRoomStatus(roomId, {
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
        this.cascadeCoordinator.cleanup(roomId).catch((err) =>
          logger.error({ err, roomId }, "Cascade cleanup failed"),
        ),
      );
    }
    await Promise.all(cleanupOps);

    // SEAT-004 FIX: Clean up owner cache to prevent memory leak
    clearRoomOwner(roomId);

    this.rooms.delete(roomId);
  }

  // ROOM-PERF-002 FIX: Synchronous — Map.get() has no async work
  getRoom(roomId: string): RoomMediaCluster | undefined {
    return this.rooms.get(roomId);
  }
}
