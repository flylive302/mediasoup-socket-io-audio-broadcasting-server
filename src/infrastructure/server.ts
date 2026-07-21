import Fastify, { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { config } from "@src/config/index.js";

import { getRedisClient } from "./redis.js";
import { createHealthRoutes } from "./health.js";
import { createEventIngestRoutes } from "./event-ingest.js";
import { createAdminRoutes } from "./drain.js";
// ⚠️ TEMPORARY — BRANCH-ONLY, DO NOT MERGE. See sentry-probe.ts.
import { createSentryProbeRoutes } from "./sentry-probe.js";
import { createInternalRoutes } from "@src/api/internal.js";
import { initializeSocket } from "@src/socket/index.js";
import { RevocationBackfillPoller } from "@src/integrations/laravel/revocation-backfill-poller.js";

import { logger } from "./logger.js";

import { createMetricsRoutes } from "./metrics.js";
import fs from "fs";

import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { StatusCoalescer } from "@src/domains/room/status-coalescer.js";
import type { WorkerManager } from "./worker.manager.js";
import type { GiftHandler } from "@src/domains/gift/giftHandler.js";
import type { AutoCloseJob } from "@src/domains/room/auto-close/index.js";
import type { PresenceService } from "@src/domains/presence/index.js";
import { RoomRegistry } from "@src/domains/room/room-registry.js";
import { PipeManager } from "@src/domains/media/pipe-manager.js";
import { CascadeCoordinator } from "@src/domains/cascade/cascade-coordinator.js";
import { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";


export interface BootstrapResult {
  server: FastifyInstance;
  io: Server;
  subClient: Redis;
  roomManager: RoomManager;
  workerManager: WorkerManager;
  giftHandler: GiftHandler;
  autoCloseJob: AutoCloseJob;
  roomRegistry: RoomRegistry;
  pipeManager: PipeManager;
  revocationPoller: RevocationBackfillPoller;
  statusCoalescer: StatusCoalescer;
  presenceService: PresenceService;
}

export async function bootstrapServer(): Promise<BootstrapResult> {
  // Configure HTTPS if certificates are provided
  const httpsOptions =
    config.SSL_KEY_PATH && config.SSL_CERT_PATH
      ? {
          key: fs.readFileSync(config.SSL_KEY_PATH),
          cert: fs.readFileSync(config.SSL_CERT_PATH),
        }
      : null;

  const fastify = (httpsOptions
    ? Fastify({
        loggerInstance: logger,
        https: httpsOptions,
      })
    : Fastify({
        loggerInstance: logger,
      })) as unknown as FastifyInstance;

  // Setup Socket.IO with Redis adapter for horizontal scaling
  const pubClient = getRedisClient();
  const subClient = pubClient.duplicate();

  const io = new Server(fastify.server, {
    cors: {
      origin: [...config.CORS_ORIGINS],
      methods: ["GET", "POST"],
      credentials: true,
    },
    // realtime-20: bound the Redis-adapter request fan-out. `fetchSockets()` &
    // co. wait for one reply per subscribed node and REJECT after this timeout
    // (no partial resolve). A node SIGKILLed before `io.close()`/Redis `quit()`
    // lingers as a subscriber, so the default 5s made every cross-node fetch on
    // the join path stall 5s then throw. 2s caps that blast radius; the
    // join-critical callers additionally degrade to local via `fetchSocketsSafe`.
    adapter: createAdapter(pubClient, subClient, { requestsTimeout: 2_000 }),
    // realtime-04 (ADR 0002 §Decision item 2): relax the heartbeat so a brief
    // background freeze SURVIVES instead of forcing a full rejoin.
    //
    // Background: a backgrounded mobile client (Chrome freeze / OS suspension)
    // cannot service the WS read or emit a PONG. The previous 5s/5s tuning
    // declared such a client dead in ~10s, so every short background blip ran
    // the disconnect-driven full leave and the user had to rebuild + rejoin on
    // return (audit `13-fe-background-audio-pwa.md` §3a). At socket.io's
    // documented defaults (25s interval / 20s timeout) a frozen-then-resumed
    // client within ~40s is never declared dead → its seat + presence are
    // retained and there is no visible reconnect. This is the highest-leverage
    // fix for the listener-drop / forced-rejoin symptom.
    //
    // Trade-off (accepted in ADR 0002 §Consequences): a genuinely-gone hard-kill
    // (no `pagehide`) now lingers up to ~45s before the disconnect-driven leave,
    // and the auto-close grace (ROOM_PRESENCE_GRACE_MS, 15s) starts only after
    // presence reaches zero — so a fully-abandoned room can show live ~60s worst
    // case. The common foreground-close case is unaffected: `pagehide` still
    // emits `room:leave` immediately (useRoomLifecycle.ts), so only hard-kills
    // pay the extra delay. ADR 0002 explicitly accepts this for launch.
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // connectionStateRecovery REMAINS DISABLED — deliberately deferred, not an
    // oversight. CSR would let a dropped transport resume its session, but it
    // still fires `disconnect` on the server, so `finalizeLeave` clears the
    // seat in Redis BEFORE the client recovers; CSR then restores socket.io
    // rooms/buffers but NOT our application seat state → the client is left
    // "half-restored" (the F-41 hazard, and the "audio seat loading" strand).
    // Safe CSR requires a per-user deferred-leave grace (defer finalizeLeave,
    // cancel on re-join) — that per-user grace does not exist yet (realtime-01
    // added ROOM-level auto-close grace only). The relaxed heartbeat above
    // already delivers AC3's behaviour (a brief freeze survives without a
    // visible reconnect) without reopening the seat-race surface that
    // realtime-01/02 just closed. Enable CSR only alongside the deferred-leave
    // grace + presence-count regression tests.
  });

  const appContext = await initializeSocket(io, pubClient);
  const { roomManager, workerManager, giftHandler, autoCloseJob, eventRouter, statusCoalescer } = appContext;

  // SFU Cascade — conditionally wire coordinator and relay
  const roomRegistry = new RoomRegistry(pubClient, logger);
  const pipeManager = new PipeManager(logger);
  let cascadeCoordinator: CascadeCoordinator | null = null;
  let cascadeRelay: CascadeRelay | null = null;

  // RoomRegistry is always exposed via context so the join handler's CAS path
  // works even if cascade isn't enabled (single-instance deploys still benefit
  // from idempotent ownership claims).
  appContext.roomRegistry = roomRegistry;
  roomManager.setRoomRegistry(roomRegistry);

  if (config.CASCADE_ENABLED) {
    cascadeRelay = new CascadeRelay(logger);
    cascadeCoordinator = new CascadeCoordinator(
      roomManager, pipeManager, roomRegistry,
      appContext.laravelClient, cascadeRelay, logger,
    );
    appContext.cascadeCoordinator = cascadeCoordinator;
    appContext.cascadeRelay = cascadeRelay;
    roomManager.setCascadeServices(cascadeCoordinator, cascadeRelay);
    logger.info("SFU cascade services wired (CASCADE_ENABLED=true)");
  }

  // F-67: reconcile any revocations whose real-time SNS emit this instance missed.
  const revocationPoller = new RevocationBackfillPoller(
    pubClient,
    appContext.laravelClient,
    logger,
  );
  revocationPoller.start();

  // Register health check
  await fastify.register(createHealthRoutes(workerManager));

  // Register metrics
  await fastify.register(createMetricsRoutes(roomManager, workerManager));

  // Register event ingest (Laravel → MSAB via SNS/HTTP)
  await fastify.register(createEventIngestRoutes(eventRouter));

  // Register admin routes (drain mode, status)
  await fastify.register(createAdminRoutes(roomManager));

  // ⚠️ TEMPORARY — BRANCH-ONLY, DO NOT MERGE. Deliberate-failure probes for
  // msab-observability-hardening tickets 01/02. Removed by rolling the
  // instance back onto master (checklist Step 5).
  await fastify.register(createSentryProbeRoutes());

  // Register internal API routes (SFU cascade)
  await fastify.register(
    createInternalRoutes({
      roomManager,
      roomRegistry,
      pipeManager,
      cascadeRelay,
      cascadeCoordinator,
      io,
      seatRepository: appContext.seatRepository,
      redis: pubClient,
    }),
    { prefix: "/" },
  );

  // Return subClient for proper cleanup during graceful shutdown
  return {
    server: fastify,
    io,
    subClient,
    roomManager,
    workerManager,
    giftHandler,
    autoCloseJob,
    roomRegistry,
    pipeManager,
    revocationPoller,
    statusCoalescer,
    presenceService: appContext.presenceService,
  };
}

