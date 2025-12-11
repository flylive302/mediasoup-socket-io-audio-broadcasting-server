import * as mediasoup from "mediasoup";
import { cpus } from "os";
import type { Logger } from "../core/logger.js";
import { mediasoupConfig } from "../config/mediasoup.js";

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
    const numWorkers = cpus().length;
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
    if (idx !== -1) {
      this.workers.splice(idx, 1);
      // Recreate replacement
      await this.createWorker(idx);
    }
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
