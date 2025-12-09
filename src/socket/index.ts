import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import { logger } from '../core/logger.js';
import { authMiddleware } from '../auth/middleware.js';
import { WorkerManager } from '../mediasoup/workerManager.js';
import { RoomManager } from '../room/roomManager.js';
import { ClientManager } from '../client/clientManager.js';

// Handlers
import { roomHandler } from './handlers/roomHandler.js';
import { mediaHandler } from './handlers/mediaHandler.js';
import { chatHandler } from './handlers/chatHandler.js';
import { seatHandler, clearUserSeat } from './handlers/seatHandler.js';
import { GiftHandler } from '../gifts/giftHandler.js';
import { LaravelClient } from '../integrations/laravelClient.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import type { AppContext } from '../context.js';

export async function initializeSocket(io: Server, redis: Redis): Promise<AppContext> {
  // Initialize Managers
  const workerManager = new WorkerManager(logger);
  await workerManager.initialize();

  const clientManager = new ClientManager();
  
  // Note: LaravelClient is instantiated inside managers/handlers as needed, 
  // or we can instantiate one singleton here.
  const laravelClient = new LaravelClient(logger);

  const roomManager = new RoomManager(workerManager, redis, io, laravelClient);
  const giftHandler = new GiftHandler(redis, io, laravelClient);
  const rateLimiter = new RateLimiter(redis);

  // Authentication Middleware
  io.use(authMiddleware);

  const appContext: AppContext = {
    io,
    redis,
    workerManager,
    roomManager,
    clientManager,
    rateLimiter,
    giftHandler,
    laravelClient
  };

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id, userId: socket.data.user?.id }, 'Socket connected');

    // Register Client
    clientManager.addClient(socket);

    // Register Handlers with Context
    roomHandler(socket, appContext);
    mediaHandler(socket, appContext);
    chatHandler(socket, appContext);
    seatHandler(socket, appContext);
    giftHandler.handle(socket);

    // Disconnect
    socket.on('disconnect', async (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Socket disconnected');
      
      const client = clientManager.getClient(socket.id);
      if (client?.roomId) {
          const userId = String(client.userId);
          
          // Clear user's seat if seated
          const clearedSeatIndex = clearUserSeat(client.roomId, userId);
          if (clearedSeatIndex !== null) {
            socket.to(client.roomId).emit('seat:cleared', { seatIndex: clearedSeatIndex });
            logger.debug({ roomId: client.roomId, userId, seatIndex: clearedSeatIndex }, 'User seat cleared on disconnect');
          }
          
          // Cleanup transports
          for (const [transportId] of client.transports) {
             try {
                 const routerMgr = await roomManager.getRoom(client.roomId);
                 if (routerMgr) {
                     const transport = routerMgr.getTransport(transportId);
                     if (transport && !transport.closed) {
                         await transport.close();
                     }
                 }
             } catch (err) {
                 logger.warn({ err, transportId }, 'Error closing transport on disconnect');
             }
          }
      }

      if (client?.roomId) {
        socket.to(client.roomId).emit('room:userLeft', { userId: client.userId });
      }

      clientManager.removeClient(socket.id);
    });
  });

  return appContext;
}
