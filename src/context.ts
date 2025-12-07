import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import type { WorkerManager } from './mediasoup/workerManager.js';
import type { RoomManager } from './room/roomManager.js';
import type { ClientManager } from './client/clientManager.js';
import type { RateLimiter } from './utils/rateLimiter.js';
import type { GiftHandler } from './gifts/giftHandler.js';
import type { LaravelClient } from './integrations/laravelClient.js';

export interface AppContext {
  io: Server;
  redis: Redis;
  workerManager: WorkerManager;
  roomManager: RoomManager;
  clientManager: ClientManager;
  rateLimiter: RateLimiter;
  giftHandler: GiftHandler;
  laravelClient: LaravelClient;
}
