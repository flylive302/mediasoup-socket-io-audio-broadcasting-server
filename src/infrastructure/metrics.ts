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
import { config } from "@src/config/index.js";
import { matchesRotatableKey, parsePreviousKeys } from "@src/shared/keyRotation.js";

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

  // gift-path-latency 11: the two hops of the result path that this service owns
  // outright. Both are measured on THIS process's clock only — a gift's enqueue
  // stamp and the flush that picks it up are both Date.now() here, so no
  // cross-machine skew can enter. Never subtract a Laravel timestamp from these.
  giftBufferWaitSeconds: new Histogram({
    name: "flylive_gift_buffer_wait_seconds",
    help: "Time a gift waited in the Redis buffer, from enqueue to flush pickup",
    // `attempt` separates the clean batching wait from retry latency. A failed
    // batch re-queues each gift with its ORIGINAL timestamp (see flush()'s
    // fallback path), so a retried gift's wait includes every failed round trip
    // to Laravel. Without this label those samples would silently inflate the
    // buffer's p95 and make ticket 12 indict the buffer for an API failure.
    // ⚠️ Read `attempt="first"` when asking "how long does batching cost?".
    labelNames: ["attempt"] as const, // first, retried
    // Straddles GIFT_BUFFER_FLUSH_INTERVAL_MS (500ms default): anything far above
    // it means flushes are backing up behind a slow Laravel, not idling.
    buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5],
    registers: [metricsRegistry],
  }),

  giftBatchPostSeconds: new Histogram({
    name: "flylive_gift_batch_post_seconds",
    help: "Wall time of the batch POST to the Laravel gift endpoint",
    labelNames: ["outcome"] as const, // success, failure
    // Centred on the observed 593ms avg / 1,572ms p95 so the tail is legible
    // rather than piling into a single overflow bucket.
    buckets: [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
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

  // Socket registration
  socketRegistrationFailures: new Counter({
    name: "flylive_socket_registration_failures_total",
    help: "Total socket registration failures (Redis unreachable during auth)",
    registers: [metricsRegistry],
  }),

  // Reverse-pipe setup (edge speaker → origin)
  // Tracks setupReversePipe outcomes so we can alarm on >5% failure rate.
  // A high failure rate means edge speakers are silent to origin/other-edge
  // listeners — which is the exact production bug Phase 4 fixes.
  reversePipeSetup: new Counter({
    name: "flylive_reverse_pipe_setup_total",
    help: "Reverse-pipe setup attempts on edge instances",
    labelNames: ["result"] as const, // success | failure
    registers: [metricsRegistry],
  }),

  // Source→distribution router piping inside one instance. A failure here
  // means a speaker is inaudible to every listener on that distribution
  // router while listeners on other routers hear him fine — the exact
  // asymmetric-audibility bug from the 2026-07-10 audio review. failure is
  // the post-retry outcome (setup now retries then throws), so alarm on ANY.
  distPipeSetup: new Counter({
    name: "flylive_dist_pipe_setup_total",
    help: "Source→distribution router pipe attempts (post-retry outcome)",
    labelNames: ["result"] as const, // success | failure
    registers: [metricsRegistry],
  }),

  // Origin→edge piping when a relayed audio:newProducer reaches an edge.
  // A failure suppresses the producer announcement on that edge — its
  // listeners never learn the speaker exists. Alarm on ANY failure.
  edgePipeSetup: new Counter({
    name: "flylive_edge_pipe_setup_total",
    help: "Origin→edge producer pipe attempts (post-retry outcome)",
    labelNames: ["result"] as const, // success | failure
    registers: [metricsRegistry],
  }),

  // Sentry events dropped client-side by the token bucket (see
  // src/infrastructure/sentry/token-bucket.ts). A silently throttling bucket
  // is indistinguishable from a healthy service, so this MUST be alerted on
  // in Grafana — a non-zero rate means real errors are not reaching Sentry.
  sentryDropped: new Counter({
    name: "flylive_sentry_dropped_total",
    help: "Sentry events dropped by the client-side token bucket",
    registers: [metricsRegistry],
  }),

  // ADR 0017 / msab-join-gates 02: the room-block Redis mirror. Every one of
  // these outcomes is a moderation failure that is otherwise invisible —
  // a failed write leaves a blocked user able to rejoin over the socket, and
  // a failed read fails OPEN by design. Alarm on ANY non-success.
  // Deliberately NOT emitted on a key miss: that is the ~99.9% path (nearly
  // every join is by a non-blocked user) and would drown the signal.
  roomBlockMirror: new Counter({
    name: "flylive_room_block_mirror_total",
    help: "Room-block Redis mirror operations by outcome",
    // operation: write | delete | read — result: success | failure
    labelNames: ["operation", "result"] as const,
    registers: [metricsRegistry],
  }),

  // platform-security 01: a media operation arrived for a room the socket
  // never joined. Every real client awaits the room:join ack before creating a
  // transport, and both recovery routes re-join first — so the steady state is
  // ZERO. A sustained non-zero rate is either a broken client build or someone
  // driving the produce chain against a room they are not in, and both need to
  // be visible rather than silently dropped.
  // Fed by transport:create / transport:connect / audio:produce ONLY.
  // transport:restartIce carries the same gate but is excluded on purpose: it
  // races teardown by design, and its benign rejections would bury the signal.
  mediaRoomGateRejections: new Counter({
    name: "flylive_media_room_gate_rejections_total",
    help: "Media operations rejected because the socket has not joined the room",
    labelNames: ["event"] as const,
    registers: [metricsRegistry],
  }),

  // platform-security 05: the in-process global per-socket event budget
  // (src/infrastructure/socketEventBudget.ts) rejected an event. Steady
  // state should be ~zero — every real client stays inside the configured
  // burst/refill (sized off the join-burst and gift-allowance floors). A
  // sustained non-zero rate means either a client is flooding or the budget
  // is sized too tight for real traffic, and either needs a human look
  // rather than showing up as unexplained client-side errors.
  socketEventBudgetExceeded: new Counter({
    name: "flylive_socket_event_budget_exceeded_total",
    help: "Socket events rejected by the global per-socket in-process event budget",
    registers: [metricsRegistry],
  }),

  // platform-security 07: a Redis operation failed and the caller continued
  // with a default/empty value. ~20 such sites across ~15 files degrade this
  // way — deliberately, so a Redis blip never takes the room down — but most
  // only LOGGED it, which means a sustained outage was visible to log
  // archaeology and invisible to alerting. One (the gift buffer's pending
  // count) was fully silent, returning a sentinel with neither log nor metric.
  //
  // Alarm on ANY sustained rate: every increment here is a subsystem quietly
  // running on fallback data. `subsystem` and `operation` are code-controlled
  // literals — never interpolate a user-supplied value into either, or this
  // becomes a cardinality hole.
  //
  // Emit ONLY via recordRedisDegradation() in shared/redis-degradation.ts,
  // which guards the call so instrumentation can never throw into the
  // degradation path it is instrumenting.
  redisDegradations: new Counter({
    name: "flylive_redis_degradation_total",
    help: "Redis operations that failed and fell back to a default value",
    labelNames: ["subsystem", "operation"] as const,
    registers: [metricsRegistry],
  }),

  // observability-audio-quality 01: the live distribution of the SFU's own
  // 0–10 audio quality score across the fleet. Higher is better, so the
  // interesting tail is the LOW end — alarm on p01/p10, not on p90.
  //
  // 🔴 CARDINALITY GATE. These are the first metrics in MSAB with a dimension
  // that could be keyed to a live, growing entity set, and they are not:
  // `direction` and `statistic` are closed enumerations, `region` and
  // `instance` are process-wide. NEVER add a room, user, consumer, producer
  // or `source` (mic/music) label here — per-listener series at target
  // concurrency produce a series count no monitoring plan absorbs. Room- and
  // user-scoped detail goes to the log stream instead (ticket 03).
  //
  // Written ONLY by qualityPublisher.ts, which resets before each tick so a
  // direction that went quiet stops publishing rather than freezing its last
  // value forever.
  audioQualityScore: new Gauge({
    name: "flylive_audio_quality_score",
    help:
      "SFU audio quality score (0-10, higher is better) across live client legs. " +
      "COVERS: a participant's own mic/music publish (direction=sending) and " +
      "audio served to a participant (direction=receiving), while unpaused. " +
      "DOES NOT COVER: paused/muted legs, cross-instance origin/edge pipe legs, " +
      "same-instance router-to-router pipe legs, or the HLS/FFmpeg broadcast egress mix.",
    labelNames: ["region", "instance", "direction", "statistic"] as const,
    registers: [metricsRegistry],
  }),

  // The denominator for the percentiles above. Published so a zero is
  // explicit — without it, "no samples" and "not scraped" look identical.
  audioQualitySamples: new Gauge({
    name: "flylive_audio_quality_samples",
    help: "Live client legs contributing to flylive_audio_quality_score, by direction",
    labelNames: ["region", "instance", "direction"] as const,
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
    // AUDIT-008 FIX: Require X-Internal-Key for all metrics endpoints
    // Prometheus format endpoint
    fastify.get("/metrics/prometheus", async (request, reply) => {
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      if (!matchesRotatableKey(internalKey, config.LARAVEL_INTERNAL_KEY, parsePreviousKeys(config.LARAVEL_INTERNAL_KEY_PREVIOUS))) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      // Update per-worker metrics before collecting
      updateWorkerMetrics(workerManager);

      reply.header("Content-Type", metricsRegistry.contentType);
      return metricsRegistry.metrics();
    });

    // JSON format endpoint (backwards compatible)
    fastify.get("/metrics", async (request, reply) => {
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      if (!matchesRotatableKey(internalKey, config.LARAVEL_INTERNAL_KEY, parsePreviousKeys(config.LARAVEL_INTERNAL_KEY_PREVIOUS))) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

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
