import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { authMiddleware } from "@src/auth/middleware.js";
import { WorkerManager } from "@src/infrastructure/worker.manager.js";
import { RoomManager } from "@src/domains/room/roomManager.js";
import { ClientManager } from "@src/client/clientManager.js";


// Handlers
import { GiftHandler } from "@src/domains/gift/giftHandler.js";
import { LaravelClient } from "@src/integrations/laravelClient.js";
import { RateLimiter } from "@src/infrastructure/rateLimiter.js";
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
  UserRoomRepository,
  EventRouter,
} from "@src/integrations/laravel/index.js";
import { metrics } from "@src/infrastructure/metrics.js";

// LT-5: Lifecycle hooks for domain-specific disconnect cleanup
import { getLifecycleHooks, type DisconnectContext } from "@src/shared/lifecycle.js";

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
  const userRoomRepository = new UserRoomRepository(redis, logger);
  const eventRouter = new EventRouter(io, userSocketRepository, clientManager, logger, redis, roomManager.state);



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
    userRoomRepository,

    eventRouter,
    cascadeCoordinator: null, // Wired in server.ts after bootstrap
    cascadeRelay: null,       // Wired in server.ts after bootstrap
    roomRegistry: null,       // Wired in server.ts after bootstrap
  };

  io.on("connection", (socket) => {
    const userId = socket.data.user?.id;

    logger.info({ socketId: socket.id, userId }, "Socket connected");

    // Register Client in ClientManager (local instance tracking)
    clientManager.addClient(socket);

    // RL-013 FIX: Register socket with retry (Redis-backed for cross-instance)
    if (userId) {
      registerWithRetry(userSocketRepository, userId, socket.id, logger);
    }



    // Register all domain handlers via domain registry
    registerAllDomains(socket, appContext);

    // GiftHandler manages a GiftBuffer with start/stop lifecycle (setInterval timer).
    // Unlike stateless domain handlers in registerAllDomains(), it requires constructor
    // injection of Redis/IO/LaravelClient and its stop() must be called during shutdown.
    giftHandler.handle(socket, appContext);

    // Disconnect — LT-5: uses lifecycle hooks for domain-specific cleanup
    socket.on("disconnect", (reason) =>
      handleDisconnect(socket, reason, {
        io,
        redis,
        clientManager,
        userSocketRepository,
        userRoomRepository,
        seatRepository,
        roomManager,
        logger,
        cascadeRelay: appContext.cascadeRelay,
        appContext,
      }),
    );
  });

  return appContext;
}

// ─────────────────────────────────────────────────────────────────
// Disconnect Handler (extracted for testability, SL-005 + SL-012)
// ─────────────────────────────────────────────────────────────────

interface DisconnectDeps {
  io: Server;
  redis: Redis;
  clientManager: ClientManager;
  userSocketRepository: UserSocketRepository;
  userRoomRepository: UserRoomRepository;
  seatRepository: SeatRepository;
  roomManager: RoomManager;
  logger: typeof logger;
  cascadeRelay: CascadeRelay | null;
  appContext: AppContext;
}

async function handleDisconnect(
  socket: Parameters<Parameters<Server["on"]>[1]>[0],
  reason: string,
  deps: DisconnectDeps,
): Promise<void> {
  const { clientManager, userSocketRepository, userRoomRepository, seatRepository, roomManager, logger: log, cascadeRelay, appContext } = deps;

  log.info({ socketId: socket.id, reason }, "Socket disconnected");

  const client = clientManager.getClient(socket.id);

  if (client?.roomId) {
    const roomId = client.roomId;
    const roomUserId = String(client.userId);

    // RT-002 FIX: Close all transports synchronously (mediasoup close() is sync)
    // Single room lookup instead of per-transport
    const cluster = roomManager.getRoom(roomId);
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
      userRoomRepository.clearUserRoom(client.userId),
      roomManager.state.adjustParticipantCount(roomId, -1),
    ]);

    // Emit seat:cleared if user was seated
    if (
      seatResult.status === "fulfilled" &&
      seatResult.value.success &&
      seatResult.value.seatIndex !== undefined
    ) {
      emitToRoom(socket, roomId, "seat:cleared", { seatIndex: seatResult.value.seatIndex }, cascadeRelay);

      log.debug(
        { roomId, userId: roomUserId, seatIndex: seatResult.value.seatIndex },
        "User seat cleared on disconnect",
      );
    }

    emitToRoom(socket, roomId, "room:userLeft", { userId: client.userId }, cascadeRelay);
  } else if (client?.userId) {
    // No room but has userId — just clean up socket registration
    await Promise.allSettled([
      userSocketRepository.unregisterSocket(client.userId, socket.id),
      userRoomRepository.clearUserRoom(client.userId),
    ]);
  }

  // LT-5: Run registered domain lifecycle hooks in parallel
  const lifecycleHooks = getLifecycleHooks();
  if (lifecycleHooks.length > 0 && client?.userId) {
    const disconnectCtx: DisconnectContext = {
      socket,
      userId: client.userId,
      roomId: client.roomId ?? null,
      reason,
    };

    const hookResults = await Promise.allSettled(
      lifecycleHooks.map((hook) => hook.onDisconnect(disconnectCtx, appContext)),
    );

    // Log any lifecycle hook failures
    hookResults.forEach((result, i) => {
      if (result.status === "rejected") {
        log.error(
          { err: result.reason, hook: lifecycleHooks[i]!.name },
          "Lifecycle hook failed during disconnect",
        );
      }
    });
  }

  clientManager.removeClient(socket.id);
}

// ─────────────────────────────────────────────────────────────────
// RL-013 FIX: Register socket with exponential backoff retry
// ─────────────────────────────────────────────────────────────────

async function registerWithRetry(
  repo: UserSocketRepository,
  userId: number,
  socketId: string,
  log: typeof logger,
  attempts = 3,
): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    const success = await repo.registerSocket(userId, socketId);
    if (success) return;
    if (i < attempts) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** (i - 1))); // 100ms, 200ms, 400ms
    }
  }
  log.error({ userId, socketId }, "Failed to register socket after retries");
  metrics.socketRegistrationFailures.inc();
}
