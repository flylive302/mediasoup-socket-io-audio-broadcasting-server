/**
 * Mediasoup Worker Manager
 * Manages mediasoup worker processes for WebRTC media handling
 * Moved to core/ as it's infrastructure-level code used across domains
 */
import * as mediasoup from "mediasoup";
import { cpus } from "os";
import type { Logger } from "./logger.js";
import { mediasoupConfig } from "../config/mediasoup.js";
import { config } from "../config/index.js";

interface WorkerInfo {
  worker: mediasoup.types.Worker;
  routerCount: number;
  cpuUsage: number;
}

export class WorkerManager {
  private readonly workers: WorkerInfo[] = [];
  private lastCpuUpdate = 0;
  private readonly CPU_UPDATE_INTERVAL = 10_000; // 10 seconds

  constructor(private readonly logger: Logger) {}

  getWorkerCount(): number {
    return this.workers.length;
  }

  /** Initialize all workers - must be called before use */
  async initialize(): Promise<void> {
    // Use configured worker count, or fallback to CPU count
    const numWorkers = config.MEDIASOUP_NUM_WORKERS ?? cpus().length;
    this.logger.info({ numWorkers }, "Creating mediasoup workers");

    const createPromises = Array.from({ length: numWorkers }, (_, i) =>
      this.createWorker(i),
    );

    await Promise.all(createPromises);
    this.logger.info({ count: this.workers.length }, "Workers initialized");
  }

  /** Get the least loaded worker */
  async getLeastLoadedWorker(): Promise<mediasoup.types.Worker> {
    if (this.workers.length === 0) {
      throw new Error("No workers available. Did you call initialize()?");
    }

    // Time-based throttle for CPU usage updates (every 10 seconds max)
    const now = Date.now();
    if (now - this.lastCpuUpdate > this.CPU_UPDATE_INTERVAL) {
      await this.updateAllCpuUsage();
      this.lastCpuUpdate = now;
    }

    // Simple sorting: router count is primary factor
    // We assume 1 router = 1 room
    let bestWorker = this.workers[0]!;

    for (const info of this.workers) {
      if (info.routerCount < bestWorker.routerCount) {
        bestWorker = info;
      }
    }

    this.logger.debug(
      {
        pid: bestWorker.worker.pid,
        routers: bestWorker.routerCount,
      },
      "Selected worker",
    );

    return bestWorker.worker;
  }

  /** Increment router count when a room is created on this worker */
  incrementRouterCount(worker: mediasoup.types.Worker): void {
    const info = this.workers.find((w) => w.worker.pid === worker.pid);
    if (info) info.routerCount++;
  }

  /** Decrement router count when a room is destroyed */
  decrementRouterCount(worker: mediasoup.types.Worker): void {
    const info = this.workers.find((w) => w.worker.pid === worker.pid);
    if (info) info.routerCount = Math.max(0, info.routerCount - 1);
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down workers");
    for (const { worker } of this.workers) {
      worker.close();
    }
    this.workers.length = 0;
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  private async createWorker(index: number): Promise<void> {
    try {
      const worker = await mediasoup.createWorker(mediasoupConfig.worker);

      worker.on("died", () => {
        this.logger.error(
          { index, pid: worker.pid },
          "Worker died, restarting...",
        );
        this.handleWorkerDeath(worker.pid);
      });

      this.workers.push({ worker, routerCount: 0, cpuUsage: 0 });
      this.logger.debug({ index, pid: worker.pid }, "Worker created");
    } catch (error) {
      this.logger.fatal({ error, index }, "Failed to create worker");
      throw error;
    }
  }

  private async handleWorkerDeath(pid: number): Promise<void> {
    const idx = this.workers.findIndex((w) => w.worker.pid === pid);
    if (idx === -1) return;

    this.workers.splice(idx, 1);

    // Retry with exponential backoff: 1s, 2s, 4s
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.createWorker(idx);
        this.logger.info(
          { idx, attempt },
          "Successfully recreated worker after death",
        );
        return;
      } catch (error) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.error(
          { error, idx, attempt, nextDelayMs: delay },
          "Failed to recreate worker, retrying...",
        );

        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.logger.fatal(
      { idx, pid, maxRetries: MAX_RETRIES },
      "Worker recreation failed after all retries",
    );
  }

  private async updateAllCpuUsage(): Promise<void> {
    try {
      await Promise.all(
        this.workers.map(async (info) => {
          const usage = await info.worker.getResourceUsage();
          info.cpuUsage = usage.ru_utime + usage.ru_stime;
        }),
      );
    } catch {
      // Ignore resource usage errors
    }
  }
}
