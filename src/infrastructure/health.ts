import type { FastifyPluginAsync } from "fastify";
import { getRedisClient } from "./redis.js";
import type { WorkerManager } from "./worker.manager.js";

export const createHealthRoutes = (
  workerManager: WorkerManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.get("/health", async (_request, reply) => {
      const redis = getRedisClient();
      // SEC-001 FIX: redis.status check is sufficient — no need for redundant ping
      let redisOk = false;
      try {
        redisOk = redis.status === "ready";
      } catch {
        // Redis unreachable
      }

      const workerCount = workerManager.getWorkerCount();
      const expectedCount = workerManager.getExpectedWorkerCount();
      const workersOk = workerCount > 0;

      // Degraded if less than half of expected workers are alive
      const workersHealthy =
        expectedCount > 0 ? workerCount >= expectedCount / 2 : workersOk;

      const status = redisOk && workersHealthy ? "ok" : "degraded";

      if (status !== "ok") {
        reply.code(503);
      }

      return {
        status,
        workers: {
          active: workerCount,
          expected: expectedCount,
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    });
  };
};
