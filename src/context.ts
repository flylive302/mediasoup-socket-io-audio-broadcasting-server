import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import type { WorkerManager } from "./core/worker.manager.js";
import type { RoomManager } from "./room/roomManager.js";
import type { ClientManager } from "./client/clientManager.js";
import type { RateLimiter } from "./utils/rateLimiter.js";
import type { GiftHandler } from "./gifts/giftHandler.js";
import type { LaravelClient } from "./integrations/laravelClient.js";
import type {
  AutoCloseService,
  AutoCloseJob,
} from "./room/auto-close/index.js";
import type { SeatRepository } from "./seat/seat.repository.js";
import type { UserSocketRepository } from "./events/userSocket.repository.js";
import type { LaravelEventSubscriber } from "./events/eventSubscriber.js";

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
  eventSubscriber: LaravelEventSubscriber;
}

