import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "../core/logger.js";
import { authMiddleware } from "../auth/middleware.js";
import { WorkerManager } from "../core/worker.manager.js";
import { RoomManager } from "../room/roomManager.js";
import { ClientManager } from "../client/clientManager.js";
import { config } from "../config/index.js";

// Handlers
import { roomHandler } from "./handlers/roomHandler.js";
import { mediaHandler } from "./handlers/mediaHandler.js";
import { chatHandler } from "./handlers/chatHandler.js";
import { userHandler } from "./handlers/userHandler.js";
import { GiftHandler } from "../gifts/giftHandler.js";
import { LaravelClient } from "../integrations/laravelClient.js";
import { RateLimiter } from "../utils/rateLimiter.js";
import type { AppContext } from "../context.js";

// Domain modules
import { registerSeatHandlers } from "../seat/index.js";
import { SeatRepository } from "../seat/seat.repository.js";

// Auto-close system
import { AutoCloseService, AutoCloseJob } from "../room/auto-close/index.js";

// Events module (Laravel pub/sub integration)
import {
  UserSocketRepository,
  LaravelEventSubscriber,
  EventRouter,
} from "../events/index.js";

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

  // Initialize seat repository (Redis-backed for horizontal scaling)
  const seatRepository = new SeatRepository(redis);

  // Initialize auto-close system
  const autoCloseService = new AutoCloseService(redis);
  const autoCloseJob = new AutoCloseJob(
    autoCloseService,
    async (roomId: string, reason: string) => {
      await roomManager.closeRoom(roomId, reason);
    },
  );
  autoCloseJob.start();

  // Initialize events system (Laravel pub/sub)
  const userSocketRepository = new UserSocketRepository(redis);
  const eventRouter = new EventRouter(io, userSocketRepository, logger);

  // Create event subscriber with router callback
  const eventSubscriber = new LaravelEventSubscriber(
    redis,
    config.MSAB_EVENTS_CHANNEL,
    (event) => {
      // Route event asynchronously (fire-and-forget with error handling)
      eventRouter.route(event).catch((err) => {
        logger.error({ err, event: event.event }, "Failed to route event");
      });
    },
    logger,
  );

  // Start event subscriber if enabled
  if (config.MSAB_EVENTS_ENABLED) {
    await eventSubscriber.start();
  } else {
    logger.info("Laravel events disabled via MSAB_EVENTS_ENABLED=false");
  }

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
    seatRepository,
    userSocketRepository,
    eventSubscriber,
  };

  io.on("connection", (socket) => {
    const userId = socket.data.user?.id;

    logger.info({ socketId: socket.id, userId }, "Socket connected");

    // Register Client in ClientManager (local instance tracking)
    clientManager.addClient(socket);

    // Register socket in UserSocketRepository (Redis-backed for cross-instance)
    if (userId) {
      userSocketRepository.registerSocket(userId, socket.id).catch((err) => {
        logger.error({ err, userId, socketId: socket.id }, "Failed to register socket");
      });
    }

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
    userHandler(socket, appContext);
    registerSeatHandlers(socket, appContext);
    giftHandler.handle(socket);

    // Disconnect
    socket.on("disconnect", async (reason) => {
      logger.info({ socketId: socket.id, reason }, "Socket disconnected");

      const client = clientManager.getClient(socket.id);

      // Unregister from UserSocketRepository (Redis)
      if (client?.userId) {
        await userSocketRepository.unregisterSocket(client.userId, socket.id);
        // Clear user's room tracking (for user:getRoom feature)
        await userSocketRepository.clearUserRoom(client.userId);
      }

      if (client?.roomId) {
        const roomUserId = String(client.userId);

        // Clear user's seat if seated (using Redis-backed repository)
        const result = await seatRepository.leaveSeat(client.roomId, roomUserId);
        if (result.success && result.seatIndex !== undefined) {
          socket
            .to(client.roomId)
            .emit("seat:cleared", { seatIndex: result.seatIndex });
          logger.debug(
            { roomId: client.roomId, userId: roomUserId, seatIndex: result.seatIndex },
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

