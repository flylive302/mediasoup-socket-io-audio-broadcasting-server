import type { FastifyPluginAsync } from "fastify";
import { getRedisClient, getCacheRedisClient } from "./redis.js";
import type { WorkerManager } from "./worker.manager.js";
import { isDraining } from "./drain.js";

export const createHealthRoutes = (
  workerManager: WorkerManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.get("/health", async (_request, reply) => {
      // Draining: return 503 immediately so NLB stops routing new connections
      if (isDraining()) {
        reply.code(503);
        return {
          status: "draining",
          workers: {
            active: workerManager.getWorkerCount(),
            expected: workerManager.getExpectedWorkerCount(),
          },
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        };
      }

      const redis = getRedisClient();
      const redisCache = getCacheRedisClient();
      // AUDIT-012 FIX: actual PING probe with timeout instead of trusting
      // status property. Both stores must answer (they are the same client
      // when no separate cache store is configured).
      let redisOk = false;
      try {
        const pings =
          redisCache === redis
            ? [redis.ping()]
            : [redis.ping(), redisCache.ping()];
        const pingResults = await Promise.race([
          Promise.all(pings),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Redis ping timeout")), 2_000),
          ),
        ]);
        redisOk = pingResults.every((r) => r === "PONG");
      } catch {
        // Redis unreachable or timed out
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
