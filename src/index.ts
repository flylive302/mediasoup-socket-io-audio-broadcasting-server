import * as Sentry from "@sentry/node";
import { logger } from "./infrastructure/logger.js";
import { config, initializeConfig } from "./config/index.js";
import { bootstrapServer } from "./infrastructure/server.js";
import { getRedisClient } from "./infrastructure/redis.js";
import { startCloudWatchPublisher, stopCloudWatchPublisher } from "./infrastructure/cloudwatch.js";
import { startDrain, isDraining, type DrainReport } from "./infrastructure/drain.js";
import { createCrashShutdown } from "./infrastructure/crash-shutdown.js";
import { waitForActiveDisconnects } from "./socket/index.js";

// ─── Module-Level Shutdown Reference ─────────────────────────────
// msab-load-stability 07: crash paths (uncaughtException, rejection breaker)
// no longer reuse the graceful drain — they route into the dedicated bounded
// crash-shutdown sequence. Set after bootstrap so the process error handlers
// can invoke it; SIGTERM/SIGINT keep the graceful drain defined in start().
let crashShutdownFn: ((reason: string) => Promise<void>) | null = null;

// ─── Sentry crash-path helpers ───────────────────────────────────
// Telemetry must never be able to stop the process from exiting, so every
// Sentry call on a crash path goes through one of these. They swallow
// everything — the handlers below are `async`, and a throw escaping one of
// them would surface as a fresh unhandledRejection, i.e. a handler that feeds
// itself while the process never exits.
type CaptureOptions = Parameters<typeof Sentry.captureException>[1];

const captureSafe = (err: unknown, options: CaptureOptions): void => {
  try {
    Sentry.captureException(err, options);
  } catch (sentryErr) {
    logger.warn({ err: sentryErr }, "Sentry capture failed");
  }
};

const captureAndFlush = async (
  err: unknown,
  timeoutMs: number,
  options: CaptureOptions,
): Promise<void> => {
  captureSafe(err, options);
  try {
    await Sentry.flush(timeoutMs);
  } catch (sentryErr) {
    logger.warn({ err: sentryErr }, "Sentry flush failed");
  }
};

const closeSentry = async (): Promise<void> => {
  try {
    await Sentry.close(config.SENTRY_CLOSE_MS);
  } catch (err) {
    logger.warn({ err }, "Sentry close failed");
  }
};

const start = async () => {
  try {
    // Resolve runtime config (INSTANCE_ID via IMDSv2) and run production
    // assertions. Must complete before bootstrapServer() because cascade
    // singletons read config.INSTANCE_ID in their constructors.
    await initializeConfig();
    logger.info({ instanceId: config.INSTANCE_ID }, "Instance identity resolved");

    // Validate config and connect to Redis early
    getRedisClient();

    const { server, io, subClient, roomManager, workerManager, giftHandler, autoCloseJob, revocationPoller, statusCoalescer, presenceService } =
      await bootstrapServer();

    const address = await server.listen({
      port: config.PORT,
      host: "0.0.0.0",
    });

    const protocol =
      config.SSL_KEY_PATH && config.SSL_CERT_PATH ? "https" : "http";
    const wsProtocol =
      config.SSL_KEY_PATH && config.SSL_CERT_PATH ? "wss" : "ws";

    logger.info(`Server listening at ${address}`);
    logger.info(`Environment: ${config.NODE_ENV}`);
    logger.info(
      `Protocol: ${protocol.toUpperCase()} / ${wsProtocol.toUpperCase()}`,
    );

    // Start CloudWatch metrics publisher (disabled in dev)
    await startCloudWatchPublisher(roomManager, workerManager);

    // Graceful Shutdown Logic
    let isShuttingDown = false;

    const gracefulShutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info({ signal }, "Graceful shutdown initiated");

      // F-5: SIGTERM (ASG scale-in / deploy rotate) must give live calls a real
      // chance to drain. Previously the ceiling was 15s — any room mid-call was
      // force-closed. Raised to 120s. The overall hard-kill timeout must exceed
      // drain + remaining cleanup, else it would pre-empt the longer drain.
      // Pairs with F-87 (ASG terminate lifecycle heartbeat aligned to ~150s).
      const DRAIN_CEILING_MS = 120_000;
      const timeoutMs = DRAIN_CEILING_MS + 30_000;
      const shutdownTimeout = setTimeout(() => {
        logger.error("Shutdown timeout exceeded, forcing exit");
        process.exit(1);
      }, timeoutMs);

      try {
        // 1. Enter drain mode and wait for rooms to close (or timeout)
        if (!isDraining()) {
          const report = await new Promise<DrainReport | null>((resolve) => {
            const drainTimeout = setTimeout(() => resolve(null), DRAIN_CEILING_MS);
            startDrain(roomManager, {
              timeoutMs: DRAIN_CEILING_MS,
              onComplete: (report) => {
                clearTimeout(drainTimeout);
                resolve(report);
              },
            });
          });

          // Honest log: only claim rooms closed when they actually did.
          if (report?.outcome === "all_rooms_closed") {
            logger.info({ report }, "Drain completed — all rooms closed, proceeding with shutdown");
          } else {
            logger.warn(
              { report },
              "Drain ceiling reached with rooms still open — proceeding with shutdown anyway",
            );
          }
        }

        // 2. Close Socket.IO (disconnect remaining clients)
        io.close();

        // F-7: io.close() fired `disconnect` for every remaining socket; those
        // handlers run async and touch the room clusters. Await them (bounded)
        // BEFORE workerManager.shutdown() tears those clusters down, so
        // transports close cleanly. Bound stays well under the F-5 ceiling.
        await waitForActiveDisconnects(15_000);

        // 3. Stop auto-close job + F-34 ownership heartbeat + revocation poller
        autoCloseJob.stop();
        roomManager.stopOwnershipHeartbeat();
        revocationPoller.stop();
        presenceService.stop();

        // realtime-02: stop the status coalescer AFTER the heartbeat so no new
        // entries can be buffered, then flush whatever is pending to Laravel.
        await statusCoalescer.stop();

        if (giftHandler) {
          await giftHandler.stop();
        }

        // 4. Shutdown mediasoup workers
        await workerManager.shutdown();

        // 5. Stop CloudWatch publisher
        stopCloudWatchPublisher();

        // 6. Close Redis connections (both pub and sub clients)
        const pubClient = getRedisClient();
        if (pubClient.status === "ready") {
          await pubClient.quit();
        }
        if (subClient.status === "ready") {
          await subClient.quit();
        }

        // 7. Close Fastify
        await server.close();

        clearTimeout(shutdownTimeout);

        // 8. Drain the Sentry queue LAST. Every rolling deploy is a 120s
        // drain window; without this, anything captured during it is
        // discarded on exit. SIGTERM itself is never reported — it is normal
        // deploy rotation, not an error.
        await closeSentry();

        logger.info("Graceful shutdown complete");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Error during shutdown");
        captureSafe(err, {
          level: "fatal",
          tags: { path: "gracefulShutdown", signal },
        });
        await closeSentry();
        process.exit(1);
      }
    };

    // Crash sequence: honest, bounded, no drain. Sentry capture+flush already
    // ran in the process handlers below before this is invoked.
    crashShutdownFn = createCrashShutdown({
      logger,
      stopBackgroundJobs: () => {
        autoCloseJob.stop();
        roomManager.stopOwnershipHeartbeat();
        revocationPoller.stop();
        presenceService.stop();
        stopCloudWatchPublisher();
      },
      flushStatus: () => statusCoalescer.stop(),
      statusPendingCount: () => statusCoalescer.pendingCount(),
      flushGifts: () => (giftHandler ? giftHandler.stop() : Promise.resolve()),
      giftPendingCount: () => (giftHandler ? giftHandler.pendingCount() : Promise.resolve(0)),
      shutdownWorkers: () => workerManager.shutdown(),
      quitRedis: async () => {
        const pubClient = getRedisClient();
        await Promise.all([
          pubClient.status === "ready" ? pubClient.quit() : Promise.resolve(),
          subClient.status === "ready" ? subClient.quit() : Promise.resolve(),
        ]).then(() => undefined);
      },
      closeServer: () => server.close().then(() => undefined),
      exit: (code) => process.exit(code),
    });

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (err) {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  }
};

// ─── Process Error Handlers ──────────────────────────────────────
// Counter-based circuit breaker: tolerate transient rejections,
// only exit if errors are systemic (5 within 30 seconds).

const REJECTION_THRESHOLD = 5;
const REJECTION_WINDOW_MS = 30_000;
const rejectionTimestamps: number[] = [];

// This path has no force-exit timer (unlike uncaughtException below), so a
// longer flush is free.
const REJECTION_FLUSH_MS = 5_000;

// The SDK's own OnUnhandledRejection integration is deliberately removed in
// src/instrument.ts — it would double-report every rejection, and it cannot
// carry the count/threshold context the circuit breaker below produces.
process.on("unhandledRejection", async (err) => {
  const now = Date.now();
  rejectionTimestamps.push(now);

  // Trim timestamps outside the sliding window
  while (rejectionTimestamps.length > 0 && rejectionTimestamps[0]! < now - REJECTION_WINDOW_MS) {
    rejectionTimestamps.shift();
  }

  if (rejectionTimestamps.length >= REJECTION_THRESHOLD) {
    logger.fatal(
      { err, count: rejectionTimestamps.length, windowMs: REJECTION_WINDOW_MS },
      `Unhandled Rejection: ${REJECTION_THRESHOLD} rejections in ${REJECTION_WINDOW_MS / 1000}s — shutting down`,
    );
    await captureAndFlush(err, REJECTION_FLUSH_MS, {
      level: "fatal",
      tags: { path: "unhandledRejection" },
      extra: { count: rejectionTimestamps.length, threshold: REJECTION_THRESHOLD },
    });
    if (crashShutdownFn) {
      void crashShutdownFn("unhandledRejection_threshold");
    } else {
      process.exit(1);
    }
  } else {
    logger.error(
      { err, count: rejectionTimestamps.length, threshold: REJECTION_THRESHOLD },
      "Unhandled Rejection (transient — process continues)",
    );
    // Captured even below the threshold, deliberately: a service leaking four
    // rejections per 30s never breaches and would otherwise stay invisible
    // forever. The token bucket bounds the volume.
    captureSafe(err, {
      level: "error",
      tags: { path: "unhandledRejection" },
      extra: { count: rejectionTimestamps.length, threshold: REJECTION_THRESHOLD },
    });
  }
});

process.on("uncaughtException", async (err) => {
  logger.fatal({ err }, "Uncaught Exception — initiating crash shutdown");

  // Reported BEFORE the crash sequence, not after — the report is the entire
  // point and must never depend on cleanup succeeding. Worst case this adds
  // SENTRY_FLUSH_MS (2s) to exit. This ordering is the
  // msab-observability-hardening guarantee; do not move it.
  await captureAndFlush(err, config.SENTRY_FLUSH_MS, {
    level: "fatal",
    // Distinguishes a crash in a running server from one during bootstrap,
    // where nothing is listening yet and there is nothing to clean up.
    tags: { path: crashShutdownFn ? "uncaughtException" : "pre-bootstrap" },
  });

  // Process is in undefined state after uncaughtException: bounded crash
  // sequence (no drain, no disconnect wait), hard-deadlined internally.
  if (crashShutdownFn) {
    void crashShutdownFn("uncaughtException");
  } else {
    // Server hasn't bootstrapped yet — just exit
    setTimeout(() => process.exit(1), 1_000);
  }
});

start();
