import type { Server as SocketServer } from 'socket.io';
import type { Redis } from 'ioredis';
import { logger } from '../core/logger.js';
import type { WorkerManager } from '../mediasoup/workerManager.js';
import { RouterManager } from '../mediasoup/routerManager.js';
import { RoomStateRepository } from './roomState.js';
import { LaravelClient } from '../integrations/laravelClient.js';
import { ActiveSpeakerDetector } from '../mediasoup/activeSpeaker.js';

export class RoomManager {
  private readonly rooms = new Map<string, RouterManager>();
  private readonly stateRepo: RoomStateRepository;

  constructor(
    private readonly workerManager: WorkerManager,
    redis: Redis,
    private readonly io: SocketServer,
    private readonly laravelClient: LaravelClient,
  ) {
    this.stateRepo = new RoomStateRepository(redis);
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
   */
  async getOrCreateRoom(roomId: string): Promise<RouterManager> {
    let routerManager = this.rooms.get(roomId);

    if (routerManager) return routerManager;

    logger.info({ roomId }, 'Creating new room');

    // 1. Get worker
    const worker = await this.workerManager.getLeastLoadedWorker();
    
    // 2. Create Router
    routerManager = new RouterManager(worker, logger);
    await routerManager.initialize();
    
    // 3. Setup Active Speaker Detector
    if (routerManager.audioObserver) {
      const detector = new ActiveSpeakerDetector(
        routerManager.audioObserver,
        roomId,
        this.io,
        logger
      );
      detector.start();
      // Store detector ref if needed for cleanup? 
      // RouterManager closes observer, so detector just stops receiving events.
    }
    
    this.rooms.set(roomId, routerManager);
    this.workerManager.incrementRouterCount(worker);

    // 4. Initialize State
    await this.stateRepo.save({
      id: roomId,
      status: 'ACTIVE',
      participantCount: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      speakers: [],
    });

    // 5. Notify Laravel Live
    await this.laravelClient.updateRoomStatus(roomId, {
      is_live: true,
      participant_count: 0
    });

    return routerManager;
  }

  /**
   * Close a room and cleanup all resources.
   */
  async closeRoom(roomId: string, reason = 'host_left'): Promise<void> {
    const routerMgr = this.rooms.get(roomId);
    if (!routerMgr) return;

    logger.info({ roomId, reason }, 'Closing room');

    // 1. Notify Frontend
    this.io.to(roomId).emit('room:closed', {
      roomId,
      reason,
      timestamp: Date.now(),
    });

    // 2. Notify Laravel
    await this.laravelClient.updateRoomStatus(roomId, {
      is_live: false,
      participant_count: 0,
      ended_at: new Date().toISOString(), // Changed from closed_at per protocol
    });

    // 3. Cleanup Mediasoup
    await routerMgr.close();
    this.rooms.delete(roomId);

    // 5. Decrement Worker Load
    this.workerManager.decrementRouterCount(routerMgr.worker);

    // 4. Cleanup Redis
    await this.stateRepo.delete(roomId);
  }

  async getRoom(roomId: string): Promise<RouterManager | undefined> {
    return this.rooms.get(roomId);
  }
}
