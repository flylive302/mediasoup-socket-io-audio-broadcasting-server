/**
 * Mediasoup Worker Manager
 * Manages mediasoup worker processes for WebRTC media handling
 * Moved to core/ as it's infrastructure-level code used across domains
 */
import * as mediasoup from "mediasoup";
import { cpus } from "os";
import type { Logger } from "./logger.js";
import { mediasoupConfig } from "@src/config/mediasoup.js";
import { config } from "@src/config/index.js";

interface WorkerInfo {
  worker: mediasoup.types.Worker;
  webRtcServer: mediasoup.types.WebRtcServer | null;
  routerCount: number;
}

export interface WorkerStats {
  pid: number;
  routerCount: number;
}

export class WorkerManager {
  private readonly workers: WorkerInfo[] = [];
  /** PERF-001: O(1) worker lookup by PID instead of O(n) array scan */
  private readonly workerByPid = new Map<number, WorkerInfo>();
  private onWorkerDied?: (workerPid: number) => void | Promise<void>;
  private expectedWorkerCount = 0;

  constructor(private readonly logger: Logger) {}

  getWorkerCount(): number {
    return this.workers.length;
  }

  getExpectedWorkerCount(): number {
    return this.expectedWorkerCount;
  }

  /** Register a callback invoked when a worker dies (before re-creation) */
  setOnWorkerDied(callback: (workerPid: number) => void | Promise<void>): void {
    this.onWorkerDied = callback;
  }

  /** Initialize all workers - must be called before use */
  async initialize(): Promise<void> {
    // Use configured worker count, or fallback to CPU count
    const numWorkers = config.MEDIASOUP_NUM_WORKERS ?? cpus().length;
    this.expectedWorkerCount = numWorkers;
    this.logger.info({ numWorkers }, "Creating mediasoup workers");

    const createPromises = Array.from({ length: numWorkers }, (_, i) =>
      this.createWorker(i),
    );

    await Promise.all(createPromises);
    this.logger.info({ count: this.workers.length }, "Workers initialized");
  }

  /** Get the least loaded worker (by router count), enforcing MAX_ROOMS_PER_WORKER */
  getLeastLoadedWorker(): mediasoup.types.Worker {
    if (this.workers.length === 0) {
      throw new Error("No workers available. Did you call initialize()?");
    }

    let bestWorker: WorkerInfo | null = null;

    for (const info of this.workers) {
      // Skip workers at capacity
      if (info.routerCount >= config.MAX_ROOMS_PER_WORKER) continue;

      if (!bestWorker || info.routerCount < bestWorker.routerCount) {
        bestWorker = info;
      }
    }

    if (!bestWorker) {
      throw new Error(
        `All workers at capacity (${config.MAX_ROOMS_PER_WORKER} routers per worker, ${this.workers.length} workers)`,
      );
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

  /** Get the WebRtcServer associated with a worker */
  getWebRtcServer(
    worker: mediasoup.types.Worker,
  ): mediasoup.types.WebRtcServer | null {
    const info = this.workerByPid.get(worker.pid);
    return info?.webRtcServer ?? null;
  }

  /** Increment router count when a room is created on this worker */
  incrementRouterCount(worker: mediasoup.types.Worker): void {
    const info = this.workerByPid.get(worker.pid);
    if (info) info.routerCount++;
  }

  /** Decrement router count when a room is destroyed */
  decrementRouterCount(worker: mediasoup.types.Worker): void {
    const info = this.workerByPid.get(worker.pid);
    if (info) info.routerCount = Math.max(0, info.routerCount - 1);
  }

  /** Get stats for all active workers */
  getWorkerStats(): WorkerStats[] {
    return this.workers.map((w) => ({
      pid: w.worker.pid,
      routerCount: w.routerCount,
    }));
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down workers");
    for (const { worker } of this.workers) {
      worker.close();
    }
    this.workers.length = 0;
    this.workerByPid.clear();
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

      // Create WebRtcServer for this worker (shared port binding)
      let webRtcServer: mediasoup.types.WebRtcServer | null = null;
      try {
        const announcedAddress = config.MEDIASOUP_ANNOUNCED_IP;
        webRtcServer = await worker.createWebRtcServer({
          listenInfos: [
            {
              protocol: "udp",
              ip: config.MEDIASOUP_LISTEN_IP,
              ...(announcedAddress ? { announcedAddress } : {}),
              port: config.MEDIASOUP_RTC_MIN_PORT + index,
            },
            {
              protocol: "tcp",
              ip: config.MEDIASOUP_LISTEN_IP,
              ...(announcedAddress ? { announcedAddress } : {}),
              port: config.MEDIASOUP_RTC_MIN_PORT + index,
            },
          ],
        });
        this.logger.debug(
          { index, pid: worker.pid, port: config.MEDIASOUP_RTC_MIN_PORT + index },
          "WebRtcServer created",
        );
      } catch (error) {
        this.logger.warn(
          { error, index },
          "Failed to create WebRtcServer, falling back to per-transport ports",
        );
      }

      const info: WorkerInfo = { worker, webRtcServer, routerCount: 0 };
      this.workers.push(info);
      this.workerByPid.set(worker.pid, info);
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
    this.workerByPid.delete(pid);

    // ARCH-002 FIX: Await cleanup of orphaned rooms before re-creating worker
    if (this.onWorkerDied) {
      try {
        await this.onWorkerDied(pid);
      } catch (error) {
        this.logger.error(
          { error, pid },
          "Error in onWorkerDied callback",
        );
      }
    }

    // RT-001 FIX: Wait for OS to release ports before re-creating worker
    // TIME_WAIT is typically 60s, but 5s is usually sufficient for port reuse
    await new Promise((resolve) => setTimeout(resolve, 5000));

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
}
