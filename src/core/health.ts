import type { FastifyPluginAsync } from 'fastify';
import { getRedisClient } from './redis.js';
import type { RoomManager } from '../room/roomManager.js';
import type { WorkerManager } from '../mediasoup/workerManager.js';

export const createHealthRoutes = (
    roomManager: RoomManager, 
    workerManager: WorkerManager
): FastifyPluginAsync => {
  return async (fastify) => {
  
  fastify.get('/health', async (_request, reply) => {
    const redis = getRedisClient();
    let redisStatus = 'down';
    try {
        if (redis.status === 'ready') {
            await redis.ping(); // Actively ping
            redisStatus = 'up';
        }
    } catch (e) {
        redisStatus = 'error';
    }
    
    // Mediasoup worker status
    const workerCount = workerManager.getWorkerCount();
    const workersHealthy = workerCount > 0;
    
    // Overall status: ok only if both Redis and workers are healthy
    const status = redisStatus === 'up' && workersHealthy ? 'ok' : 'degraded';
    if (status !== 'ok') {
        reply.code(503);
    }

    return {
      status,
      uptime: process.uptime(),
      redis: redisStatus,
      workers: {
        count: workerCount,
        healthy: workersHealthy
      },
      rooms: roomManager.getRoomCount(), 
      timestamp: new Date().toISOString(),
    };
    });
  };
};
