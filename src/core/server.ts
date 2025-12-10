import Fastify, { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from '../config/index.js';

import { getRedisClient } from './redis.js';
import { createHealthRoutes } from './health.js';
import { initializeSocket } from '../socket/index.js';

import { logger } from './logger.js';

import { createMetricsRoutes } from './metrics.js';
import fs from 'fs';


export async function bootstrapServer() {
  // Configure HTTPS if certificates are provided
  const httpsOptions = config.SSL_KEY_PATH && config.SSL_CERT_PATH 
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



  // Setup Socket.IO
  const pubClient = getRedisClient();
  const subClient = pubClient.duplicate();

  const io = new Server(fastify.server, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  const socketManagers = await initializeSocket(io, pubClient);

  // Register health check
  await fastify.register(createHealthRoutes(socketManagers.roomManager, socketManagers.workerManager));

  // Register metrics
  await fastify.register(createMetricsRoutes(socketManagers.roomManager, socketManagers.workerManager));

  return { server: fastify, ...socketManagers };
}
