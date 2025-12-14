import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { getRedisClient } from "./redis.js";
import type { RoomManager } from "../room/roomManager.js";
import type { WorkerManager } from "../mediasoup/workerManager.js";

export const createHealthRoutes = (
  roomManager: RoomManager,
  workerManager: WorkerManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.get("/health", async (_request, reply) => {
      const redis = getRedisClient();
      let redisStatus = "down";
      try {
        if (redis.status === "ready") {
          await redis.ping(); // Actively ping
          redisStatus = "up";
        }
      } catch {
        redisStatus = "error";
      }

      // Mediasoup worker status
      const workerCount = workerManager.getWorkerCount();
      const workersHealthy = workerCount > 0;

      // Overall status: ok only if both Redis and workers are healthy
      const status = redisStatus === "up" && workersHealthy ? "ok" : "degraded";
      if (status !== "ok") {
        reply.code(503);
      }

      return {
        status,
        uptime: process.uptime(),
        redis: redisStatus,
        workers: {
          count: workerCount,
          healthy: workersHealthy,
        },
        rooms: roomManager.getRoomCount(),
        timestamp: new Date().toISOString(),
        build: getVersionInfo(),
      };
    });
  };
};

function getVersionInfo() {
  try {
    // In production, version.json is expected to be in the project root (process.cwd())
    // or next to the built files.
    // We try to read it from the current working directory first.
    // The build script generates it in src/version.json, which becomes dist/version.json or root depending on copy.
    // Dockerfile with COPY src ./src keeps it in src.
    // Let's assume it ends up in the current working directory or we find it relative to this file.

    // Using fs to avoid build errors if file is missing in dev

    let versionPath = path.resolve(process.cwd(), "version.json");
    if (!fs.existsSync(versionPath)) {
      // Try looking in src/ (for dev) or dist/ (for prod relative)
      versionPath = path.resolve(process.cwd(), "src/version.json");
    }

    if (fs.existsSync(versionPath)) {
      const content = fs.readFileSync(versionPath, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore errors
  }

  return {
    commit: "unknown",
    branch: "unknown",
    message: "unknown",
  };
}
