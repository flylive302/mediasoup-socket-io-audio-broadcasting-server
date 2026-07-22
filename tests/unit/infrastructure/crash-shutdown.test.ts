import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCrashShutdown, type CrashShutdownDeps } from "@src/infrastructure/crash-shutdown.js";

/**
 * msab-load-stability 07 — crash-shutdown sequence at its module seam.
 * Prior art: leave-finalizer unit tests (dependency-injected harness).
 * Asserts external behavior only: exit codes/ordering, dropped-count logs,
 * cleanup-despite-failure, backstop firing — never internal call sequences.
 */

const never = () => new Promise<void>(() => {});

function harness(overrides: Partial<CrashShutdownDeps> = {}) {
  const logs: { level: string; obj: unknown; msg: string }[] = [];
  const log = (level: string) => (obj: unknown, msg: string) => {
    logs.push({ level, obj, msg });
  };
  const calls: string[] = [];
  const exit = vi.fn((code: number) => {
    calls.push(`exit(${code})`);
  });

  const deps: CrashShutdownDeps = {
    logger: { fatal: log("fatal"), error: log("error"), warn: log("warn"), info: log("info") },
    stopBackgroundJobs: vi.fn(() => calls.push("stopBackgroundJobs")),
    flushStatus: vi.fn(async () => {
      calls.push("flushStatus");
    }),
    statusPendingCount: () => 3,
    flushGifts: vi.fn(async () => {
      calls.push("flushGifts");
    }),
    giftPendingCount: async () => 7,
    shutdownWorkers: vi.fn(async () => {
      calls.push("shutdownWorkers");
    }),
    quitRedis: vi.fn(async () => {
      calls.push("quitRedis");
    }),
    closeServer: vi.fn(async () => {
      calls.push("closeServer");
    }),
    exit,
    flushCapMs: 2_500,
    hardDeadlineMs: 10_000,
    ...overrides,
  };

  return { deps, logs, calls, exit, run: createCrashShutdown(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("crash shutdown", () => {
  it("happy path: flushes, cleans up, exits 1 — and never touches drain/socket.io (no such deps exist)", async () => {
    const { run, calls, exit } = harness();
    await run("uncaughtException");

    expect(calls).toEqual([
      "stopBackgroundJobs",
      "flushStatus",
      "flushGifts",
      "shutdownWorkers",
      "quitRedis",
      "closeServer",
      "exit(1)",
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("slow Laravel status flush → dropped and pending count logged; cleanup still runs", async () => {
    const { run, calls, logs, exit } = harness({ flushStatus: never });
    const done = run("unhandledRejection_threshold");
    await vi.advanceTimersByTimeAsync(2_600); // past the 2.5s cap
    await done;

    const dropLog = logs.find((l) => l.msg.includes("buffered room statuses DROPPED"));
    expect(dropLog).toBeDefined();
    expect(dropLog!.obj).toMatchObject({ droppedRoomStatuses: 3, cause: "timeout" });
    expect(calls).toContain("shutdownWorkers");
    expect(calls).toContain("quitRedis");
    expect(calls).toContain("closeServer");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("slow gift flush → logged as left-in-Redis with count; cleanup still runs", async () => {
    const { run, calls, logs } = harness({ flushGifts: never });
    const done = run("uncaughtException");
    await vi.advanceTimersByTimeAsync(2_600);
    await done;

    const giftLog = logs.find((l) => l.msg.includes("gifts remain in Redis"));
    expect(giftLog).toBeDefined();
    expect(giftLog!.obj).toMatchObject({ giftsLeftInRedisQueue: 7 });
    expect(calls).toContain("shutdownWorkers");
  });

  it("cleanup runs even when both flushes REJECT", async () => {
    const { run, calls, exit } = harness({
      flushStatus: async () => {
        throw new Error("laravel down");
      },
      flushGifts: async () => {
        throw new Error("redis down");
      },
    });
    await run("uncaughtException");

    expect(calls).toContain("shutdownWorkers");
    expect(calls).toContain("quitRedis");
    expect(calls).toContain("closeServer");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("cleanup step failure never blocks the following steps or the exit", async () => {
    const { run, calls, exit } = harness({
      shutdownWorkers: async () => {
        throw new Error("worker died differently");
      },
    });
    await run("uncaughtException");

    expect(calls).toContain("quitRedis");
    expect(calls).toContain("closeServer");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("10s hard-deadline backstop forces exit(1) when the sequence overruns", async () => {
    // Every async step hangs and the per-step cap exceeds the deadline, so
    // only the backstop can end this.
    const { run, exit, logs } = harness({
      flushStatus: never,
      flushGifts: never,
      shutdownWorkers: never,
      flushCapMs: 60_000,
      hardDeadlineMs: 10_000,
    });
    void run("uncaughtException");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.some((l) => l.msg.includes("hard deadline exceeded"))).toBe(true);
  });

  it("is idempotent — a second crash signal is a no-op", async () => {
    const { run, deps, exit } = harness();
    await run("uncaughtException");
    await run("unhandledRejection_threshold");

    expect(deps.stopBackgroundJobs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("announces the crash with the distinct drain-skipped marker and what was skipped", async () => {
    const { run, logs } = harness();
    await run("uncaughtException");

    const marker = logs.find((l) => l.msg.includes("Crash shutdown initiated (drain skipped)"));
    expect(marker).toBeDefined();
    expect(marker!.level).toBe("fatal");
    expect(marker!.obj).toMatchObject({
      reason: "uncaughtException",
      skipped: ["room drain", "socket.io close", "disconnect wait"],
    });
  });
});
