import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import type { WorkerManager } from "./infrastructure/worker.manager.js";
import type { RoomManager } from "./domains/room/roomManager.js";
import type { ClientManager } from "./client/clientManager.js";
import type { RateLimiter } from "./infrastructure/rateLimiter.js";
import type { GiftHandler } from "./domains/gift/giftHandler.js";
import type { LaravelClient } from "./integrations/laravelClient.js";
import type {
  AutoCloseService,
  AutoCloseJob,
} from "./domains/room/auto-close/index.js";
import type { SeatRepository } from "./domains/seat/seat.repository.js";
import type { UserSocketRepository } from "./integrations/laravel/user-socket.repository.js";
import type { UserRoomRepository } from "./integrations/laravel/user-room.repository.js";

import type { EventRouter } from "./integrations/laravel/event-router.js";
import type { CascadeCoordinator } from "./domains/cascade/cascade-coordinator.js";
import type { CascadeRelay } from "./domains/cascade/cascade-relay.js";
import type { RoomRegistry } from "./domains/room/room-registry.js";


export interface AppContext {
  io: Server;
  redis: Redis;
  workerManager: WorkerManager;
  roomManager: RoomManager;
  clientManager: ClientManager;
  rateLimiter: RateLimiter;
  giftHandler: GiftHandler;
  laravelClient: LaravelClient;
  autoCloseService: AutoCloseService;
  autoCloseJob: AutoCloseJob;
  seatRepository: SeatRepository;
  userSocketRepository: UserSocketRepository;
  userRoomRepository: UserRoomRepository;

  eventRouter: EventRouter;
  cascadeCoordinator: CascadeCoordinator | null;
  cascadeRelay: CascadeRelay | null;
  roomRegistry: RoomRegistry | null;
}