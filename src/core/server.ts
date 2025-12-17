import Fastify, { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { config } from "../config/index.js";

import { getRedisClient } from "./redis.js";
import { createHealthRoutes } from "./health.js";
import { initializeSocket } from "../socket/index.js";

import { logger } from "./logger.js";

import { createMetricsRoutes } from "./metrics.js";
import fs from "fs";

import type { RoomManager } from "../room/roomManager.js";
import type { WorkerManager } from "./worker.manager.js";
import type { GiftHandler } from "../gifts/giftHandler.js";
import type { AutoCloseJob } from "../room/auto-close/index.js";

export interface BootstrapResult {
  server: FastifyInstance;
  io: Server;
  subClient: Redis;
  roomManager: RoomManager;
  workerManager: WorkerManager;
  giftHandler: GiftHandler;
  autoCloseJob: AutoCloseJob;
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
      origin: config.CORS_ORIGINS,
      methods: ["GET", "POST"],
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  const { roomManager, workerManager, giftHandler, autoCloseJob } =
    await initializeSocket(io, pubClient);

  // Register health check
  await fastify.register(createHealthRoutes(roomManager, workerManager));

  // Register metrics
  await fastify.register(createMetricsRoutes(roomManager, workerManager));

  // Return subClient for proper cleanup during graceful shutdown
  return {
    server: fastify,
    io,
    subClient,
    roomManager,
    workerManager,
    giftHandler,
    autoCloseJob,
  };
}
