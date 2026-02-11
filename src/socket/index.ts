import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";
import { authMiddleware } from "@src/auth/middleware.js";
import { WorkerManager } from "@src/infrastructure/worker.manager.js";
import { RoomManager } from "@src/domains/room/roomManager.js";
import { ClientManager } from "@src/client/clientManager.js";
import { config } from "@src/config/index.js";

// Handlers
import { GiftHandler } from "@src/domains/gift/giftHandler.js";
import { LaravelClient } from "@src/integrations/laravelClient.js";
import { RateLimiter } from "@src/utils/rateLimiter.js";
import type { AppContext } from "@src/context.js";

// Domain Registry - registers all domain handlers
import { registerAllDomains } from "@src/domains/index.js";

// Domain modules
import { SeatRepository } from "@src/domains/seat/seat.repository.js";

// Auto-close system
import { AutoCloseService, AutoCloseJob } from "@src/domains/room/auto-close/index.js";

// Events module (Laravel pub/sub integration)
import {
  UserSocketRepository,
  LaravelEventSubscriber,
  EventRouter,
} from "@src/integrations/laravel/index.js";

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

  // Initialize seat repository (Redis-backed for horizontal scaling)
  const seatRepository = new SeatRepository(redis);

  const roomManager = new RoomManager(workerManager, redis, io, laravelClient, seatRepository);
  const giftHandler = new GiftHandler(redis, io, laravelClient);
  const rateLimiter = new RateLimiter(redis);

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
  const userSocketRepository = new UserSocketRepository(redis, logger);
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



    // Register all domain handlers via domain registry
    registerAllDomains(socket, appContext);

    // GiftHandler is a stateful class with lifecycle management (start/stop)
    // so it's registered separately from the domain array
    giftHandler.handle(socket, appContext);

    // Disconnect
    socket.on("disconnect", (reason) =>
      handleDisconnect(socket, reason, {
        clientManager,
        userSocketRepository,
        seatRepository,
        roomManager,
        logger,
      }),
    );
  });

  return appContext;
}

// ─────────────────────────────────────────────────────────────────
// Disconnect Handler (extracted for testability, SL-005 + SL-012)
// ─────────────────────────────────────────────────────────────────

interface DisconnectDeps {
  clientManager: ClientManager;
  userSocketRepository: UserSocketRepository;
  seatRepository: SeatRepository;
  roomManager: RoomManager;
  logger: typeof logger;
}

async function handleDisconnect(
  socket: Parameters<Parameters<Server["on"]>[1]>[0],
  reason: string,
  deps: DisconnectDeps,
): Promise<void> {
  const { clientManager, userSocketRepository, seatRepository, roomManager, logger: log } = deps;

  log.info({ socketId: socket.id, reason }, "Socket disconnected");

  const client = clientManager.getClient(socket.id);

  if (client?.roomId) {
    const roomId = client.roomId;
    const roomUserId = String(client.userId);

    // RT-002 FIX: Close all transports synchronously (mediasoup close() is sync)
    // Single room lookup instead of per-transport
    const cluster = await roomManager.getRoom(roomId);
    if (cluster) {
      for (const [transportId] of client.transports) {
        try {
          const transport = cluster.getTransport(transportId);
          if (transport && !transport.closed) {
            transport.close();
          }
        } catch {
          // Worker may already be dead
        }
      }
    }

    // RT-002 FIX: Parallel Redis cleanup — don't await sequentially
    const [seatResult] = await Promise.allSettled([
      seatRepository.leaveSeat(roomId, roomUserId),
      userSocketRepository.unregisterSocket(client.userId, socket.id),
      userSocketRepository.clearUserRoom(client.userId),
      roomManager.state.adjustParticipantCount(roomId, -1),
    ]);

    // Emit seat:cleared if user was seated
    if (
      seatResult.status === "fulfilled" &&
      seatResult.value.success &&
      seatResult.value.seatIndex !== undefined
    ) {
      socket
        .to(roomId)
        .emit("seat:cleared", { seatIndex: seatResult.value.seatIndex });
      log.debug(
        { roomId, userId: roomUserId, seatIndex: seatResult.value.seatIndex },
        "User seat cleared on disconnect",
      );
    }

    socket.to(roomId).emit("room:userLeft", { userId: client.userId });
  } else if (client?.userId) {
    // No room but has userId — just clean up socket registration
    await Promise.allSettled([
      userSocketRepository.unregisterSocket(client.userId, socket.id),
      userSocketRepository.clearUserRoom(client.userId),
    ]);
  }

  clientManager.removeClient(socket.id);
}
