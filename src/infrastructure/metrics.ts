/**
 * Prometheus-compatible metrics for observability
 * Provides both JSON metrics (/metrics) and Prometheus format (/metrics/prometheus)
 */
import type { FastifyPluginAsync } from "fastify";
import os from "os";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { WorkerManager } from "./worker.manager.js";

// Create a custom registry
export const metricsRegistry = new Registry();

// Add default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Application-specific metrics
 */
export const metrics = {
  // Socket Connections
  socketConnections: new Gauge({
    name: "flylive_socket_connections_total",
    help: "Current number of active socket connections",
    registers: [metricsRegistry],
  }),

  // Room metrics
  roomsActive: new Gauge({
    name: "flylive_rooms_active",
    help: "Number of currently active rooms",
    registers: [metricsRegistry],
  }),

  // Socket event processing
  eventsTotal: new Counter({
    name: "flylive_socket_events_total",
    help: "Total number of socket events processed",
    labelNames: ["event", "status"] as const,
    registers: [metricsRegistry],
  }),

  eventLatency: new Histogram({
    name: "flylive_socket_event_latency_seconds",
    help: "Socket event processing latency in seconds",
    labelNames: ["event"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [metricsRegistry],
  }),

  // Mediasoup workers
  workersActive: new Gauge({
    name: "flylive_mediasoup_workers_active",
    help: "Number of active mediasoup workers",
    registers: [metricsRegistry],
  }),

  // Per-worker router count (labeled by worker PID)
  routersPerWorker: new Gauge({
    name: "flylive_mediasoup_routers_per_worker",
    help: "Number of routers per mediasoup worker",
    labelNames: ["worker_pid"] as const,
    registers: [metricsRegistry],
  }),

  // Gift processing
  giftsProcessed: new Counter({
    name: "flylive_gifts_processed_total",
    help: "Total number of gifts processed",
    labelNames: ["status"] as const, // success, failed, dead_letter
    registers: [metricsRegistry],
  }),

  giftBatchSize: new Histogram({
    name: "flylive_gift_batch_size",
    help: "Size of gift batches sent to Laravel",
    buckets: [1, 5, 10, 25, 50, 100],
    registers: [metricsRegistry],
  }),

  // GF-006 FIX: Dead-letter queue size for alerting
  giftDeadLetterSize: new Gauge({
    name: "flylive_gift_dead_letter_size",
    help: "Current size of the gift dead-letter queue",
    registers: [metricsRegistry],
  }),

  // Laravel API calls
  laravelApiCalls: new Counter({
    name: "flylive_laravel_api_calls_total",
    help: "Total Laravel API calls",
    labelNames: ["endpoint", "status"] as const,
    registers: [metricsRegistry],
  }),

  laravelApiLatency: new Histogram({
    name: "flylive_laravel_api_latency_seconds",
    help: "Laravel API call latency in seconds",
    labelNames: ["endpoint"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metricsRegistry],
  }),

  // Authentication
  authAttempts: new Counter({
    name: "flylive_auth_attempts_total",
    help: "Authentication attempts",
    labelNames: ["result"] as const, // success, invalid_token, no_token, cache_hit
    registers: [metricsRegistry],
  }),

  // Laravel Events (Redis pub/sub)
  laravelEventsReceived: new Counter({
    name: "flylive_laravel_events_received_total",
    help: "Total Laravel events received via Redis pub/sub",
    labelNames: ["event_type", "delivered"] as const,
    registers: [metricsRegistry],
  }),

  // Laravel Events backpressure
  laravelEventsInFlight: new Gauge({
    name: "flylive_laravel_events_in_flight",
    help: "Number of Laravel events currently being processed",
    registers: [metricsRegistry],
  }),

  laravelEventProcessingDuration: new Histogram({
    name: "flylive_laravel_event_processing_duration_seconds",
    help: "Time to process a single Laravel event",
    labelNames: ["event_type"] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [metricsRegistry],
  }),
};

/**
 * Metrics Fastify routes plugin
 */
export const createMetricsRoutes = (
  roomManager: RoomManager,
  workerManager: WorkerManager,
): FastifyPluginAsync => {
  return async (fastify) => {
    // Prometheus format endpoint
    fastify.get("/metrics/prometheus", async (_request, reply) => {
      // Update per-worker metrics before collecting
      updateWorkerMetrics(workerManager);

      reply.header("Content-Type", metricsRegistry.contentType);
      return metricsRegistry.metrics();
    });

    // JSON format endpoint (backwards compatible)
    fastify.get("/metrics", async () => {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      const uptime = process.uptime();
      const workerStats = workerManager.getWorkerStats();

      return {
        system: {
          uptime,
          memory: {
            rss: memoryUsage.rss,
            heapTotal: memoryUsage.heapTotal,
            heapUsed: memoryUsage.heapUsed,
            external: memoryUsage.external,
          },
          cpu: cpuUsage,
          loadAverage: os.loadavg(),
          freemem: os.freemem(),
          totalmem: os.totalmem(),
        },
        application: {
          rooms: roomManager.getRoomCount(),
          activeWorkers: workerManager.getWorkerCount(),
          expectedWorkers: workerManager.getExpectedWorkerCount(),
          workers: workerStats,
          concurrency: os.cpus().length,
        },
        timestamp: new Date().toISOString(),
      };
    });
  };
};

/**
 * Update per-worker Prometheus gauges
 */
function updateWorkerMetrics(workerManager: WorkerManager): void {
  // Reset all labels first to remove stale workers
  metrics.routersPerWorker.reset();
  metrics.workersActive.set(workerManager.getWorkerCount());

  for (const stat of workerManager.getWorkerStats()) {
    metrics.routersPerWorker.set({ worker_pid: String(stat.pid) }, stat.routerCount);
  }
}
