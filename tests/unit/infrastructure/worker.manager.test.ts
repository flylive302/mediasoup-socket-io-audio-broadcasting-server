import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mediasoup — native module that can't run in test env
vi.mock("mediasoup", () => ({
  createWorker: vi.fn(),
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
});
