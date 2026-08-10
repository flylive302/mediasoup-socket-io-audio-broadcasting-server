import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock mediasoup — native module that can't run in test env
vi.mock("mediasoup", () => ({
  createWorker: vi.fn(),
}));

// 24-cpu-pinning: pinning must be deterministic in tests — fixed platform and
// a controllable core count, with taskset captured instead of executed.
vi.mock("os", () => ({
  cpus: vi.fn(() => Array.from({ length: 8 }, () => ({}) as never)),
  platform: vi.fn(() => "linux"),
}));
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("@src/config/mediasoup.js", () => ({
  mediasoupConfig: { worker: { logLevel: "warn", logTags: [] } },
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    MEDIASOUP_NUM_WORKERS: 2,
    MAX_ROOMS_PER_WORKER: 100,
    MEDIASOUP_LISTEN_IP: "0.0.0.0",
    MEDIASOUP_ANNOUNCED_IP: "",
    MEDIASOUP_RTC_MIN_PORT: 30000,
  },
}));

import * as mediasoup from "mediasoup";
import { cpus } from "os";
import { execSync } from "child_process";
import { config } from "@src/config/index.js";
import { WorkerManager } from "@src/infrastructure/worker.manager.js";

// ─── Helpers ────────────────────────────────────────────────────────

let pidCounter = 1000;

function createMockWorker() {
  const pid = pidCounter++;
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  return {
    pid,
    on(event: string, handler: (...args: unknown[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    close: vi.fn(),
    createWebRtcServer: vi.fn().mockResolvedValue({
      close: vi.fn(),
    }),
    // Simulate emitting a "died" event
    _triggerDied() {
      for (const handler of listeners["died"] || []) handler();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ─── Tests ──────────────────────────────────────────────────────────

describe("WorkerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pidCounter = 1000;
  });

  describe("initialize", () => {
    it("creates the configured number of workers", async () => {
      const workers = [createMockWorker(), createMockWorker()];
      let callIdx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve(workers[callIdx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      expect(wm.getWorkerCount()).toBe(2);
      expect(wm.getExpectedWorkerCount()).toBe(2);
    });
  });

  describe("PERF-001: PID Map", () => {
    it("tracks workers by PID for O(1) lookup via getWebRtcServer", async () => {
      const worker = createMockWorker();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockResolvedValue(worker);

      const wm = new WorkerManager(mockLogger);
      // Only create 1 worker for this test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(mediasoup.createWorker).mockResolvedValueOnce(worker as any);

      // Manually initialize 1 worker
      await wm.initialize();

      // getWebRtcServer uses workerByPid internally
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = wm.getWebRtcServer(worker as any);
      expect(server).toBeDefined();
    });
  });

  describe("router count tracking", () => {
    it("increments and decrements router counts", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2][idx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.incrementRouterCount(w1 as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.incrementRouterCount(w1 as any);

      let stats = wm.getWorkerStats();
      expect(stats.find((s: { pid: number }) => s.pid === w1.pid)?.routerCount).toBe(2);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.decrementRouterCount(w1 as any);
      stats = wm.getWorkerStats();
      expect(stats.find((s: { pid: number }) => s.pid === w1.pid)?.routerCount).toBe(1);
    });

    it("does not decrement below zero", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2][idx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.decrementRouterCount(w1 as any);
      const stats = wm.getWorkerStats();
      expect(stats.find((s: { pid: number }) => s.pid === w1.pid)?.routerCount).toBe(0);
    });
  });

  describe("getLeastLoadedWorker", () => {
    it("throws when no workers are available", () => {
      const wm = new WorkerManager(mockLogger);
      expect(() => wm.getLeastLoadedWorker()).toThrow("No workers available");
    });

    it("selects the worker with fewest routers", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2][idx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      // Load w1 with 5 routers
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (let i = 0; i < 5; i++) wm.incrementRouterCount(w1 as any);

      const selected = wm.getLeastLoadedWorker();
      expect(selected.pid).toBe(w2.pid);
    });

    // prod-bugs 09 (NODE-MSAB-6): a distribution router must never share a
    // worker with its source router — same-worker pipeToRouter always throws
    // "Channel request handler with ID … already exists".
    it("excludes the given pid even when that worker is least loaded", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2][idx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      // w2 is more loaded, but w1 (least loaded) is the source's worker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (let i = 0; i < 5; i++) wm.incrementRouterCount(w2 as any);

      const selected = wm.getLeastLoadedWorker(w1.pid);
      expect(selected.pid).toBe(w2.pid);
    });

    it("prefers an over-capacity different worker to the excluded one", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2][idx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      // Push w2 past the soft cap (MAX_ROOMS_PER_WORKER default 100).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (let i = 0; i < 150; i++) wm.incrementRouterCount(w2 as any);

      const selected = wm.getLeastLoadedWorker(w1.pid);
      expect(selected.pid).toBe(w2.pid);
    });

    it("falls back to the excluded worker only when it is the sole worker", async () => {
      const w1 = createMockWorker();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() => Promise.resolve(w1));

      const wm = new WorkerManager(mockLogger);
      // Every createWorker call yields the same mock, so all slots share one
      // pid — excluding it models the single-worker deployment.
      await wm.initialize();

      const selected = wm.getLeastLoadedWorker(w1.pid);
      expect(selected.pid).toBe(w1.pid);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("closes all workers", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2][idx++]),
      );

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();

      await wm.shutdown();

      expect(w1.close).toHaveBeenCalled();
      expect(w2.close).toHaveBeenCalled();
      expect(wm.getWorkerCount()).toBe(0);
    });
  });

  describe("ARCH-002: onWorkerDied callback", () => {
    it("calls the registered callback with dead worker PID", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = createMockWorker();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockResolvedValue(worker as any);

      const wm = new WorkerManager(mockLogger);
      wm.setOnWorkerDied(callback);
      await wm.initialize();

      // Trigger worker death — handleWorkerDeath is async and waits 5s
      // We just verify the callback is called (don't wait for full re-creation)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (wm as any).handleWorkerDeath(worker.pid);

      // Wait a small amount for the callback to be invoked
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith(worker.pid);
      });

      // Cancel the timer-based portion
    });
  });

  // 24-cpu-pinning-and-router-placement: pinning derives from worker count and
  // core count, reserves core 0 (the Node.js event loop) at EVERY size, and no
  // arithmetic is tuned to one instance size. Asserted at multiple worker
  // counts including the stated minimum (3 vCPU → 2 workers).
  describe("ticket 24: CPU pinning is size-parametric and reserves core 0", () => {
    async function initWith(workerCount: number, coreCount: number) {
      vi.mocked(cpus).mockReturnValue(
        Array.from({ length: coreCount }, () => ({}) as never),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).MEDIASOUP_NUM_WORKERS = workerCount;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve(createMockWorker()),
      );
      const wm = new WorkerManager(mockLogger);
      await wm.initialize();
      return wm;
    }

    function pinnedCores(): number[] {
      return vi
        .mocked(execSync)
        .mock.calls.map(([cmd]) => {
          const m = String(cmd).match(/taskset -cp (\d+)/);
          expect(m).not.toBeNull();
          return Number(m![1]);
        })
        .sort((a, b) => a - b);
    }

    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).MEDIASOUP_NUM_WORKERS = 2;
    });

    it("minimum size (3 cores, 2 derived workers): each worker gets its own core, core 0 untouched", async () => {
      await initWith(2, 3);
      expect(pinnedCores()).toEqual([1, 2]);
    });

    it("4 cores, 3 derived workers: cores 1..3, core 0 untouched", async () => {
      await initWith(3, 4);
      expect(pinnedCores()).toEqual([1, 2, 3]);
    });

    it("6 cores, 5 derived workers: cores 1..5, core 0 untouched", async () => {
      await initWith(5, 6);
      expect(pinnedCores()).toEqual([1, 2, 3, 4, 5]);
    });

    it("oversubscribed explicit override (3 cores, 4 workers): workers share cores 1..2, core 0 STILL reserved, and it is loud", async () => {
      await initWith(4, 3);
      expect(pinnedCores()).toEqual([1, 1, 2, 2]);
      expect(pinnedCores()).not.toContain(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("share cores"),
      );
    });

    it("single core: pinning skipped loudly (cannot reserve the event-loop core)", async () => {
      await initWith(2, 1);
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("cannot reserve the event-loop core"),
      );
    });
  });

  // 24-cpu-pinning-and-router-placement: distribution-router placement must
  // spread across the non-source workers — never all forced onto one worker —
  // whenever more than one non-source worker exists.
  describe("ticket 24: distribution routers spread across non-source workers", () => {
    it("at 3 workers, successive distribution placements land on BOTH non-source workers", async () => {
      const w1 = createMockWorker();
      const w2 = createMockWorker();
      const w3 = createMockWorker();
      let idx = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mediasoup.createWorker as any).mockImplementation(() =>
        Promise.resolve([w1, w2, w3][idx++]),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).MEDIASOUP_NUM_WORKERS = 3;

      const wm = new WorkerManager(mockLogger);
      await wm.initialize();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).MEDIASOUP_NUM_WORKERS = 2;

      // w1 hosts the source router.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.incrementRouterCount(w1 as any);

      const first = wm.getLeastLoadedWorker(w1.pid);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.incrementRouterCount(first as any);
      const second = wm.getLeastLoadedWorker(w1.pid);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wm.incrementRouterCount(second as any);

      const landed = new Set([first.pid, second.pid]);
      expect(landed.has(w1.pid)).toBe(false);
      expect(landed.size).toBe(2); // spread, not stacked on one worker
    });
  });
});
