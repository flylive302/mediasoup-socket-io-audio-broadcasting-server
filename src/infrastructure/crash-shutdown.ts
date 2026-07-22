/**
 * Crash-path shutdown sequence (msab-load-stability 07).
 *
 * Both `uncaughtException` and the unhandled-rejection circuit breaker route
 * here — one crash behavior. Unlike the SIGTERM/SIGINT graceful path this
 * NEVER drains rooms and NEVER waits on Socket.IO disconnects: sockets drop
 * hard, clients reconnect, and seat self-heal + the ownership heartbeat absorb
 * the residue. Sentry fatal capture-and-flush happens BEFORE this module is
 * invoked (src/index.ts) — that ordering is the msab-observability-hardening
 * guarantee and must not move in here.
 *
 * Sequence: stop background jobs → buffer flushes under a crash-specific cap
 * (on breach: drop and log counts; never the 30s Laravel HTTP timeout) →
 * resource cleanup (mediasoup workers, Redis pub+sub, HTTP server) which runs
 * even when the flushes fail → exit(1). An overall hard deadline backstops the
 * whole sequence with a forced exit(1).
 */
import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";

export interface CrashShutdownDeps {
  logger: Pick<Logger, "fatal" | "error" | "warn" | "info">;
  /** Synchronous timer/job stops (auto-close, heartbeat, pollers, CloudWatch). */
  stopBackgroundJobs: () => void;
  /** statusCoalescer.stop() — flushes its in-memory pending map to Laravel. */
  flushStatus: () => Promise<void>;
  /** Rooms with a buffered, unsent status — lost on exit if the flush missed the cap. */
  statusPendingCount: () => number;
  /** giftHandler.stop() — final Redis-queue flush to Laravel. */
  flushGifts: () => Promise<void>;
  /** Gifts still in the Redis queue (persist across exit; -1 = Redis unreachable). */
  giftPendingCount: () => Promise<number>;
  shutdownWorkers: () => Promise<void>;
  quitRedis: () => Promise<void>;
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  flushCapMs?: number;
  hardDeadlineMs?: number;
}

export function createCrashShutdown(deps: CrashShutdownDeps): (reason: string) => Promise<void> {
  const {
    logger,
    exit,
    flushCapMs = config.CRASH_FLUSH_CAP_MS,
    hardDeadlineMs = config.CRASH_HARD_DEADLINE_MS,
  } = deps;

  let started = false;

  return async function crashShutdown(reason: string): Promise<void> {
    if (started) return;
    started = true;

    logger.fatal(
      { reason, flushCapMs, hardDeadlineMs, skipped: ["room drain", "socket.io close", "disconnect wait"] },
      "Crash shutdown initiated (drain skipped) — sockets dropped hard, clients will reconnect",
    );

    // Backstop: nothing below may keep this process alive past the deadline.
    const backstop = setTimeout(() => {
      logger.fatal({ hardDeadlineMs }, "Crash shutdown hard deadline exceeded — forcing exit(1)");
      exit(1);
    }, hardDeadlineMs);
    backstop.unref?.();

    // 1. Stop timers/jobs so nothing re-buffers while we flush.
    try {
      deps.stopBackgroundJobs();
    } catch (err) {
      logger.warn({ err }, "Crash shutdown: background job stop failed — continuing");
    }

    // 2. Buffer flushes under the crash cap. On cap breach or error the writes
    // are abandoned and the counts logged. Cleanup below runs regardless.
    const statusFlushed = await raceCap(deps.flushStatus(), flushCapMs);
    if (!statusFlushed.ok) {
      logger.error(
        { droppedRoomStatuses: safeCount(deps.statusPendingCount), cause: statusFlushed.cause },
        "Crash shutdown: status flush missed the cap — buffered room statuses DROPPED",
      );
    }

    const giftsFlushed = await raceCap(deps.flushGifts(), flushCapMs);
    if (!giftsFlushed.ok) {
      logger.error(
        { giftsLeftInRedisQueue: await deps.giftPendingCount().catch(() => -1), cause: giftsFlushed.cause },
        "Crash shutdown: gift flush missed the cap — gifts remain in Redis for the next instance",
      );
    }

    // 3. Resource cleanup — each step independent so one failure never blocks
    // the rest (workers especially: orphaned workers outlive the process).
    await step("mediasoup worker shutdown", deps.shutdownWorkers);
    await step("Redis pub+sub quit", deps.quitRedis);
    await step("HTTP server close", deps.closeServer);

    logger.fatal(
      { reason, statusFlushed: statusFlushed.ok, giftsFlushed: giftsFlushed.ok },
      "Crash shutdown complete — exit(1)",
    );
    clearTimeout(backstop);
    exit(1);
  };

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    const result = await raceCap(fn(), flushCapMs);
    if (!result.ok) {
      logger.error({ step: name, cause: result.cause }, "Crash shutdown: cleanup step failed — continuing");
    }
  }
}

type CapResult = { ok: true } | { ok: false; cause: "timeout" | unknown };

/** Bound a promise to the crash cap; the loser is abandoned, never awaited again. */
async function raceCap(p: Promise<void>, capMs: number): Promise<CapResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const winner = await Promise.race([
      p.then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), capMs);
        timer.unref?.();
      }),
    ]);
    if (winner === "timeout") return { ok: false, cause: "timeout" };
    return { ok: true };
  } catch (err) {
    return { ok: false, cause: err };
  } finally {
    if (timer) clearTimeout(timer);
    // Abandoned loser must not become a fresh unhandledRejection mid-crash.
    p.catch(() => {});
  }
}

function safeCount(fn: () => number): number {
  try {
    return fn();
  } catch {
    return -1;
  }
}
