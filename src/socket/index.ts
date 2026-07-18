import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@src/infrastructure/logger.js";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
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
import { PresenceTracker } from "@src/domains/room/presence-tracker.js";
import { StatusCoalescer } from "@src/domains/room/status-coalescer.js";
import { RoomModeService } from "@src/domains/room/mode/room-mode.service.js";
import { createBroadcastController } from "@src/domains/broadcast/index.js";
import { finalizeLeave } from "@src/domains/room/leave-finalizer.js";
import { PresenceService } from "@src/domains/presence/index.js";

// Events module (Laravel pub/sub integration)
import {
  UserSocketRepository,
  UserRoomRepository,
  EventRouter,
} from "@src/integrations/laravel/index.js";
import { metrics } from "@src/infrastructure/metrics.js";

// LT-5: Lifecycle hooks for domain-specific disconnect cleanup
import { getLifecycleHooks, type DisconnectContext } from "@src/shared/lifecycle.js";

// ─────────────────────────────────────────────────────────────────
// F-7: track in-flight disconnect handlers so graceful shutdown can
// await them between io.close() (which fires `disconnect` for every
// socket) and workerManager.shutdown() (which tears down the routers
// those handlers are still touching). Without this the handlers race
// cluster teardown — transports may not close cleanly.
// ─────────────────────────────────────────────────────────────────

const activeDisconnects = new Set<Promise<void>>();

export function waitForActiveDisconnects(timeoutMs: number): Promise<void> {
  if (activeDisconnects.size === 0) return Promise.resolve();
  const drained = Promise.allSettled([...activeDisconnects]).then(() => {});
  const timed = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref?.();
  });
  return Promise.race([drained, timed]);
}

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

  // realtime-02: coalesce Room status churn → ≤1 update/Room/window to Laravel.
  const statusCoalescer = new StatusCoalescer(laravelClient, logger);
  statusCoalescer.start();

  // Initialize seat repository (Redis-backed for horizontal scaling)
  const seatRepository = new SeatRepository(redis);

  const roomManager = new RoomManager(workerManager, redis, io, laravelClient, statusCoalescer, seatRepository);
  const giftHandler = new GiftHandler(redis, io, laravelClient);
  const rateLimiter = new RateLimiter(redis);

  // realtime-01: presence is the authoritative source of "who is in a Room".
  // Built from roomManager.state so it can heal the advisory integer + TTL.
  const presenceTracker = new PresenceTracker(io, roomManager.state);
  roomManager.setPresenceTracker(presenceTracker);

  // realtime-08: the interactive↔broadcast flip is evaluated on the same
  // ownership heartbeat that reconciles presence (no second poll loop).
  const roomModeService = new RoomModeService(roomManager.state, io, logger);
  roomManager.setRoomModeService(roomModeService);

  // realtime-09: broadcast HLS publish tier. When a Room flips to broadcast mode
  // the controller mixes seated speakers into one HLS stream → R2 → CDN. No-op
  // unless BROADCAST_HLS_ENABLED. Wired as the mode-transition REACT hook.
  const broadcastController = createBroadcastController(roomManager);
  roomModeService.setTransitionHook((roomId, transition) =>
    broadcastController.onModeTransition(roomId, transition),
  );
  roomManager.setBroadcastClosedHook((roomId) =>
    broadcastController.onRoomClosed(roomId),
  );

  // dm-realtime-platform/07: DM presence (connection-count, per-user, TTL'd).
  // Started here (sweep timer) and stopped in the graceful-shutdown sequence
  // (src/index.ts), mirroring autoCloseJob/statusCoalescer.
  const presenceService = new PresenceService(redis, io, clientManager);
  presenceService.start();

  // Initialize auto-close system (presence-gated, not integer-gated)
  const autoCloseService = new AutoCloseService(redis, presenceTracker);
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
  const eventRouter = new EventRouter(
    io,
    userSocketRepository,
    clientManager,
    logger,
    redis,
    roomManager.state,
    // realtime-13 (L2): only tear down when THIS instance hosts the room's
    // cluster — a non-hosting instance no-ops so closeRoom's unsafe orphan-reap
    // branch is never reached from an admin force-close.
    (roomId, reason) =>
      roomManager.getRoom(roomId)
        ? roomManager.closeRoom(roomId, reason)
        : Promise.resolve(),
    // room-seat-caps/02: shrink-eviction path (producer close + seat:cleared/seat:evicted).
    roomManager,
    // room-blocks/02 (ADR 0017): ejection machinery deps for the unified kick
    // path — driven by the room.member_removed fanout instead of room:kick.
    seatRepository,
    statusCoalescer,
    userRoomRepository,
  );



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
    statusCoalescer,
    autoCloseService,
    autoCloseJob,
    presenceTracker,
    roomModeService,
    broadcastController,
    seatRepository,
    userSocketRepository,
    userRoomRepository,
    presenceService,

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

    // F-1: live connection gauge — drives CW ActiveConnections + ASG scaling
    metrics.socketConnections.inc();

    // RL-013 FIX: Register socket with retry (Redis-backed for cross-instance)
    if (userId) {
      registerWithRetry(userSocketRepository, userId, socket.id, logger);
    }

    // dm-realtime-platform/07: presence INCR (0→1 emits online). Fire-and-forget
    // (REACT) — a presence hiccup must never block the connection.
    if (userId) {
      void presenceService.onConnect(userId);
    }



    // Register all domain handlers via domain registry
    registerAllDomains(socket, appContext);

    // GiftHandler manages a GiftBuffer with start/stop lifecycle (setInterval timer).
    // Unlike stateless domain handlers in registerAllDomains(), it requires constructor
    // injection of Redis/IO/LaravelClient and its stop() must be called during shutdown.
    giftHandler.handle(socket, appContext);

    // Disconnect — LT-5: uses lifecycle hooks for domain-specific cleanup
    socket.on("disconnect", (reason) => {
      // F-7: register the in-flight handler so shutdown can await it.
      const p = handleDisconnect(socket, reason, {
        io,
        redis,
        clientManager,
        userSocketRepository,
        userRoomRepository,
        roomManager,
        logger,
        cascadeRelay: appContext.cascadeRelay,
        appContext,
        presenceService,
      });
      activeDisconnects.add(p);
      void p.finally(() => activeDisconnects.delete(p));
    });
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
  roomManager: RoomManager;
  logger: typeof logger;
  cascadeRelay: CascadeRelay | null;
  appContext: AppContext;
  presenceService: PresenceService;
}

async function handleDisconnect(
  socket: Parameters<Parameters<Server["on"]>[1]>[0],
  reason: string,
  deps: DisconnectDeps,
): Promise<void> {
  const { clientManager, userSocketRepository, userRoomRepository, logger: log, appContext, presenceService } = deps;

  log.info({ socketId: socket.id, reason }, "Socket disconnected");

  const client = clientManager.getClient(socket.id);

  // dm-realtime-platform/07: presence DECR (<=0 emits offline). Fire-and-forget
  // (REACT). Must run for every disconnected socket regardless of room state.
  if (client?.userId) {
    void presenceService.onDisconnect(client.userId);
  }
  // Capture the room BEFORE finalizeLeave (which clears client.roomId) so the
  // lifecycle-hook context below still carries it.
  const disconnectRoomId = client?.roomId ?? null;

  if (client?.roomId) {
    const roomId = client.roomId;

    // realtime-01: a dead socket is a full leave. Run the ONE symmetric teardown
    // (transports, seat, client/user room, activity, seat:cleared + room:userLeft,
    // presence-authoritative count → Laravel is_live/participant_count). This is
    // the path that previously skipped the Laravel update entirely (Cause A / H3:
    // disconnect is the dominant mobile leave, so Rooms showed phantom-live).
    // realtime-22: a SEATED user is the one exception — finalizeLeave holds their
    // slot (marks disconnectedAt, suppresses seat:cleared + room:userLeft) through
    // SEAT_RETENTION_GRACE_MS so a genuine death that recovers within the window
    // re-claims the same seat on rejoin. Presence/count still reconcile (the socket
    // IS gone). The ownership heartbeat sweeps the seat if the window expires.
    await finalizeLeave(socket, appContext, roomId, { viaDisconnect: true });

    // Disconnect-only: also drop the cross-instance socket registration.
    await userSocketRepository
      .unregisterSocket(client.userId, socket.id)
      .catch((err) =>
        log.error({ err, socketId: socket.id }, "unregisterSocket on disconnect failed"),
      );
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
      // finalizeLeave clears client.roomId — use the value captured up-front.
      roomId: disconnectRoomId,
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

  // F-41: identity-guarded — if a connectionStateRecovery resume re-registered
  // a fresh ClientData under this socket.id while we were draining, `client`
  // (captured at handler entry) no longer matches and the delete is skipped.
  clientManager.removeClient(socket.id, client ?? undefined);

  // F-1: pair with the .inc() in the connection handler
  metrics.socketConnections.dec();
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
