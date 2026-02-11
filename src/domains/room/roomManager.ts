import type { Server as SocketServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";
import type { WorkerManager } from "@src/infrastructure/worker.manager.js";
import { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import { RoomStateRepository } from "./roomState.js";
import { LaravelClient } from "@src/integrations/laravelClient.js";
import { ActiveSpeakerDetector } from "@src/domains/media/activeSpeaker.js";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";

export class RoomManager {
  private readonly rooms = new Map<string, RoomMediaCluster>();
  private readonly stateRepo: RoomStateRepository;

  // Track rooms being created to prevent race conditions
  private readonly creatingRooms = new Map<string, Promise<RoomMediaCluster>>();

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

  getRoomCount(): number {
    return this.rooms.size;
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
        logger,
      );
      detector.setCluster(cluster);
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
      speakers: [],
    });

    // 4. Notify Laravel Live
    await this.laravelClient.updateRoomStatus(roomId, {
      is_live: true,
      participant_count: 0,
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

    // 1. Notify Frontend
    this.io.to(roomId).emit("room:closed", {
      roomId,
      reason,
      timestamp: Date.now(),
    });

    // 2. Notify Laravel (fire-and-forget — don't block mediasoup cleanup on Laravel)
    this.laravelClient
      .updateRoomStatus(roomId, {
        is_live: false,
        participant_count: 0,
        ended_at: new Date().toISOString(),
      })
      .catch((err) =>
        logger.error({ err, roomId }, "Laravel close status update failed"),
      );

    // 3. Cleanup Mediasoup (cluster handles all its routers)
    await cluster.close();
    this.rooms.delete(roomId);

    // 4. Cleanup Redis
    await this.stateRepo.delete(roomId);

    // BL-009 FIX: Cleanup seat data (seats hash, locked set, invite keys)
    if (this.seatRepository) {
      await this.seatRepository.clearRoom(roomId);
    }
  }

  async getRoom(roomId: string): Promise<RoomMediaCluster | undefined> {
    return this.rooms.get(roomId);
  }
}
