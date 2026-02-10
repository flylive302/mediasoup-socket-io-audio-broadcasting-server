import type { FastifyPluginAsync } from "fastify";
import { getRedisClient } from "./redis.js";
import type { WorkerManager } from "./worker.manager.js";

export const createHealthRoutes = (
  workerManager: WorkerManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.get("/health", async (_request, reply) => {
      const redis = getRedisClient();
      let redisOk = false;
      try {
        if (redis.status === "ready") {
          await redis.ping();
          redisOk = true;
        }
      } catch {
        // Redis unreachable
      }

      const workersOk = workerManager.getWorkerCount() > 0;
      const status = redisOk && workersOk ? "ok" : "degraded";

      if (status !== "ok") {
        reply.code(503);
      }

      return {
        status,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    });
  };
};
