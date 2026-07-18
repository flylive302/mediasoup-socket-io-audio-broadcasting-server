import { logger } from "./infrastructure/logger.js";
import { config, initializeConfig } from "./config/index.js";
import { bootstrapServer } from "./infrastructure/server.js";
import { getRedisClient } from "./infrastructure/redis.js";
import { startCloudWatchPublisher, stopCloudWatchPublisher } from "./infrastructure/cloudwatch.js";
import { startDrain, isDraining } from "./infrastructure/drain.js";
import { waitForActiveDisconnects } from "./socket/index.js";

// ─── Module-Level Shutdown Reference ─────────────────────────────
// Set after bootstrap so process error handlers can invoke graceful shutdown.
let shutdownFn: ((signal: string) => Promise<void>) | null = null;

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
          await new Promise<void>((resolve) => {
            const drainTimeout = setTimeout(resolve, DRAIN_CEILING_MS);
            startDrain(roomManager, {
              timeoutMs: DRAIN_CEILING_MS,
              onComplete: () => {
                clearTimeout(drainTimeout);
                resolve();
              },
            });
          });
          logger.info("Drain completed, proceeding with shutdown");
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
        logger.info("Graceful shutdown complete");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Error during shutdown");
        process.exit(1);
      }
    };

    // Expose to module-level error handlers
    shutdownFn = gracefulShutdown;

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

process.on("unhandledRejection", (err) => {
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
    if (shutdownFn) {
      void shutdownFn("unhandledRejection_threshold");
    } else {
      process.exit(1);
    }
  } else {
    logger.error(
      { err, count: rejectionTimestamps.length, threshold: REJECTION_THRESHOLD },
      "Unhandled Rejection (transient — process continues)",
    );
  }
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught Exception — initiating graceful shutdown");
  // Process is in undefined state after uncaughtException.
  // Attempt graceful drain if possible, with a hard 3s deadline.
  if (shutdownFn) {
    const forceExit = setTimeout(() => process.exit(1), 3_000);
    void shutdownFn("uncaughtException").finally(() => {
      clearTimeout(forceExit);
      process.exit(1);
    });
  } else {
    // Server hasn't bootstrapped yet — just exit
    setTimeout(() => process.exit(1), 1_000);
  }
});

start();
