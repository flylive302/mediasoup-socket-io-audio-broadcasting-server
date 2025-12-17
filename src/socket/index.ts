import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "../core/logger.js";
import { authMiddleware } from "../auth/middleware.js";
import { WorkerManager } from "../core/worker.manager.js";
import { RoomManager } from "../room/roomManager.js";
import { ClientManager } from "../client/clientManager.js";

// Handlers
import { roomHandler } from "./handlers/roomHandler.js";
import { mediaHandler } from "./handlers/mediaHandler.js";
import { chatHandler } from "./handlers/chatHandler.js";
import { GiftHandler } from "../gifts/giftHandler.js";
import { LaravelClient } from "../integrations/laravelClient.js";
import { RateLimiter } from "../utils/rateLimiter.js";
import type { AppContext } from "../context.js";

// Domain modules
import { registerSeatHandlers, clearUserSeat } from "../seat/index.js";

// Auto-close system
import { AutoCloseService, AutoCloseJob } from "../room/auto-close/index.js";

export async function initializeSocket(
  io: Server,
  redis: Redis,
): Promise<AppContext> {
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

  // Initialize auto-close system
  const autoCloseService = new AutoCloseService(redis);
  const autoCloseJob = new AutoCloseJob(
    autoCloseService,
    async (roomId: string, reason: string) => {
      await roomManager.closeRoom(roomId, reason);
    }
  );
  autoCloseJob.start();

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
    laravelClient,
    autoCloseService,
    autoCloseJob,
  };

  io.on("connection", (socket) => {
    logger.info(
      { socketId: socket.id, userId: socket.data.user?.id },
      "Socket connected",
    );

    // Register Client
    clientManager.addClient(socket);

    // Debug: Log all incoming socket events (temporary for debugging)
    socket.onAny((eventName, ...args) => {
      if (eventName === "seat:lock" || eventName === "seat:invite") {
        logger.info(
          { socketId: socket.id, eventName, argsCount: args.length },
          "Socket event received",
        );
      }
    });

    // Register Handlers with Context
    roomHandler(socket, appContext);
    mediaHandler(socket, appContext);
    chatHandler(socket, appContext);
    registerSeatHandlers(socket, appContext);
    giftHandler.handle(socket);

    // Disconnect
    socket.on("disconnect", async (reason) => {
      logger.info({ socketId: socket.id, reason }, "Socket disconnected");

      const client = clientManager.getClient(socket.id);
      if (client?.roomId) {
        const userId = String(client.userId);

        // Clear user's seat if seated
        const clearedSeatIndex = clearUserSeat(client.roomId, userId);
        if (clearedSeatIndex !== null) {
          socket
            .to(client.roomId)
            .emit("seat:cleared", { seatIndex: clearedSeatIndex });
          logger.debug(
            { roomId: client.roomId, userId, seatIndex: clearedSeatIndex },
            "User seat cleared on disconnect",
          );
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
            logger.warn(
              { err, transportId },
              "Error closing transport on disconnect",
            );
          }
        }
      }

      if (client?.roomId) {
        socket
          .to(client.roomId)
          .emit("room:userLeft", { userId: client.userId });
      }

      clientManager.removeClient(socket.id);
    });
  });

  return appContext;
}
