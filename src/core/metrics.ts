import type { FastifyPluginAsync } from "fastify";
import os from "os";
import type { RoomManager } from "../room/roomManager.js";
import type { WorkerManager } from "../mediasoup/workerManager.js";

export const createMetricsRoutes = (
  roomManager: RoomManager,
  workerManager: WorkerManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.get("/metrics", async () => {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      const uptime = process.uptime();

      return {
        system: {
          uptime,
          memory: {
            rss: memoryUsage.rss,
            heapTotal: memoryUsage.heapTotal,
            heapUsed: memoryUsage.heapUsed,
            external: memoryUsage.external,
          },
          cpu: cpuUsage,
          loadAverage: os.loadavg(),
          freemem: os.freemem(),
          totalmem: os.totalmem(),
        },
        application: {
          rooms: roomManager.getRoomCount(),
          activeWorkers: workerManager.getWorkerCount(),
          concurrency: os.cpus().length,
        },
        timestamp: new Date().toISOString(),
      };
    });
  };
};
