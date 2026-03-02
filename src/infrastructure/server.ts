import Fastify, { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { config } from "@src/config/index.js";

import { getRedisClient } from "./redis.js";
import { createHealthRoutes } from "./health.js";
import { createEventIngestRoutes } from "./event-ingest.js";
import { createAdminRoutes } from "./drain.js";
import { createInternalRoutes } from "@src/api/internal.js";
import { initializeSocket } from "@src/socket/index.js";

import { logger } from "./logger.js";

import { createMetricsRoutes } from "./metrics.js";
import fs from "fs";

import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { WorkerManager } from "./worker.manager.js";
import type { GiftHandler } from "@src/domains/gift/giftHandler.js";
import type { AutoCloseJob } from "@src/domains/room/auto-close/index.js";
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
    adapter: createAdapter(pubClient, subClient),
  });

  const appContext = await initializeSocket(io, pubClient);
  const { roomManager, workerManager, giftHandler, autoCloseJob, eventRouter } = appContext;

  // SFU Cascade — conditionally wire coordinator and relay
  const roomRegistry = new RoomRegistry(pubClient, logger);
  const pipeManager = new PipeManager(logger);
  let cascadeCoordinator: CascadeCoordinator | null = null;
  let cascadeRelay: CascadeRelay | null = null;

  if (config.CASCADE_ENABLED) {
    cascadeRelay = new CascadeRelay(logger);
    cascadeCoordinator = new CascadeCoordinator(
      roomManager, pipeManager,
      appContext.laravelClient, cascadeRelay, logger,
    );
    appContext.cascadeCoordinator = cascadeCoordinator;
    appContext.cascadeRelay = cascadeRelay;
    roomManager.setCascadeServices(cascadeCoordinator, cascadeRelay);
    logger.info("SFU cascade services wired (CASCADE_ENABLED=true)");
  }

  // Register health check
  await fastify.register(createHealthRoutes(workerManager));

  // Register metrics
  await fastify.register(createMetricsRoutes(roomManager, workerManager));

  // Register event ingest (Laravel → MSAB via SNS/HTTP)
  await fastify.register(createEventIngestRoutes(eventRouter));

  // Register admin routes (drain mode, status)
  await fastify.register(createAdminRoutes(roomManager));

  // Register internal API routes (SFU cascade)
  await fastify.register(
    createInternalRoutes({
      roomManager,
      roomRegistry,
      pipeManager,
      cascadeRelay,
      cascadeCoordinator,
      io,
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
  };
}

