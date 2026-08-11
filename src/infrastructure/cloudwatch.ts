/**
 * CloudWatch Metrics Publisher
 *
 * Publishes custom application metrics to AWS CloudWatch for auto-scaling
 * decisions and fleet alarms.
 * - Namespace: FlyLive/MSAB
 * - Resolution: Standard (60s interval)
 * - Metric list: see the MetricData array built in publishMetrics() below —
 *   deliberately not duplicated here, this header already drifted out of
 *   sync with the code once (ticket 32 pt.2).
 *
 * Disabled when:
 * - NODE_ENV=development
 * - CLOUDWATCH_ENABLED=false
 * - No IAM instance profile (logs warning once, then silently skips)
 */
import { config } from "@src/config/index.js";
import { logger } from "./logger.js";
import { metrics, metricsRegistry, updateWorkerMetrics } from "./metrics.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { WorkerManager } from "./worker.manager.js";

const NAMESPACE = "FlyLive/MSAB";
const PUBLISH_INTERVAL_MS = 60_000; // 60 seconds

// Lazy-loaded AWS SDK client (only imported when needed)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cwClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PutMetricDataCommand: any;
let sdkLoadFailed = false;

let publishHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the AWS CloudWatch client (lazy)
 */
async function getClient() {
  if (sdkLoadFailed) return null;
  if (cwClient) return cwClient;

  try {
    const sdk = await import("@aws-sdk/client-cloudwatch");
    PutMetricDataCommand = sdk.PutMetricDataCommand;
    cwClient = new sdk.CloudWatchClient({});
    return cwClient;
  } catch (err) {
    sdkLoadFailed = true;
    logger.warn(
      { err },
      "CloudWatch SDK not available — metrics publishing disabled. Install @aws-sdk/client-cloudwatch to enable.",
    );
    return null;
  }
}

type CloudWatchUnit = "Count" | "Percent" | "Seconds";

interface MetricDatum {
  MetricName: string;
  Value: number;
  Unit: CloudWatchUnit;
  Timestamp: Date;
  Dimensions?: { Name: string; Value: string }[];
}

/**
 * Build the dimensioned + dimensionless pair for one metric value.
 *
 * TIER0 (EVIDENCE-REPORT alarm-dimension mismatch / F-14/F-28/F-86 — see
 * terraform/modules/cloudwatch/main.tf): CloudWatch metric alarms cannot use
 * SEARCH() and cannot enumerate per-instance dimensions, so a fleet-wide
 * alarm can only ever read a DIMENSIONLESS stream. Every instance writes
 * exactly one datapoint per 60s period into that shared stream, so a
 * 60s-period alarm with statistic Sum (counts) or Average (ratios/percents)
 * is a true fleet aggregate.
 *
 * Every metric this file publishes goes through this helper so that
 * asymmetry can't quietly reappear one metric at a time — it already did
 * once: `ReversePipeSetupSuccess`/`ReversePipeSetupFailure` and
 * `MaxRoomListeners` shipped dimensioned-only, with no dimensionless twin,
 * which is why the `reverse_pipe_failure_rate` Terraform alarm (queried
 * with no dimensions block) read an empty stream and could never fire.
 * `treat_missing_data = "notBreaching"` made that look healthy. Fixed here
 * (ticket 32 pt.2) by routing those three through `pair()` too. The
 * dimensioned-vs-dimensionless assertion in cloudwatch.test.ts is what
 * stops the defect from coming back.
 */
function pair(
  name: string,
  value: number,
  unit: CloudWatchUnit,
  now: Date,
  dimensions: { Name: string; Value: string }[],
): MetricDatum[] {
  return [
    { MetricName: name, Value: value, Unit: unit, Timestamp: now, Dimensions: dimensions },
    { MetricName: name, Value: value, Unit: unit, Timestamp: now },
  ];
}

/**
 * Publish metrics to CloudWatch
 */
async function publishMetrics(
  roomManager: RoomManager,
  workerManager: WorkerManager,
): Promise<void> {
  const client = await getClient();
  if (!client) return;

  try {
    const now = new Date();
    const dimensions = [{ Name: "InstanceId", Value: config.INSTANCE_ID }];

    // Gather metric values
    const activeRooms = roomManager.getRoomCount();
    const workerCount = workerManager.getWorkerCount();

    // Get active connections from Prometheus gauge
    const connectionsMetric = await metrics.socketConnections.get();
    const activeConnections =
      connectionsMetric.values.length > 0 && connectionsMetric.values[0]
        ? connectionsMetric.values[0].value
        : 0;

    // Get average CPU load (system load avg as proxy for worker CPU)
    const os = await import("os");
    const cpuCount = os.cpus().length || 1;
    const loadAvg1m = os.loadavg()[0] ?? 0;
    const workerCpuPercent = Math.min(100, (loadAvg1m / cpuCount) * 100);

    // Max listeners in any single room (for cascade threshold monitoring)
    const maxRoomListeners = roomManager.getMaxRoomListeners();

    // Reverse-pipe setup outcomes (cumulative counters from Prometheus).
    // Cumulative is fine — CloudWatch alarms use RATE() math expressions to
    // turn cumulative counts into per-minute rates and compute % failure.
    const reverseSetupMetric = await metrics.reversePipeSetup.get();
    let reverseSetupSuccess = 0;
    let reverseSetupFailure = 0;
    for (const v of reverseSetupMetric.values) {
      if (v.labels.result === "success") reverseSetupSuccess = v.value;
      else if (v.labels.result === "failure") reverseSetupFailure = v.value;
    }

    // ticket 32 pt.2: five more registry metrics bridged into CloudWatch.
    // Per the metrics-pipeline decision the Prometheus registry (metrics.ts)
    // is the single instrumentation surface — everything below reads FROM
    // the registry rather than adding a new direct read of a manager or
    // `os` (the CPU read above predates that decision and is left as-is).

    // Event-loop lag p99. `nodejs_eventloop_lag_p99_seconds` is a
    // collectDefaultMetrics gauge that is only refreshed as a side effect of
    // the BASE `nodejs_eventloop_lag_seconds` gauge's own collect()
    // callback (prom-client's eventLoopLag.js sets all the percentile/min/
    // max/mean gauges from inside that one callback). Reading the p99 gauge
    // directly returns whatever a previous scrape last computed — verified
    // empirically that it reads a stale 0 on a registry nobody has scraped
    // yet. Touch the base gauge first to run that collect(), the same way a
    // real `/metrics/prometheus` scrape does (Registry.metrics() calls
    // `.get()` on every registered metric).
    //
    // ⚠️ SIDE EFFECT: that collect() ends with `histogram.reset()` on the
    // shared `monitorEventLoopDelay` window (prom-client's eventLoopLag.js),
    // so this 60s tick resets the SAME window a real Prometheus scrape of
    // `/metrics/prometheus` also reads from. Every `nodejs_eventloop_lag_*`
    // series now reports "since whichever reader collected last" instead of
    // "since the last scrape" — if Prometheus scrapes more often than 60s
    // (the common case), this call only shortens that window further; if
    // nothing scrapes `/metrics/prometheus` at all, this is the only thing
    // keeping the gauge from being frozen at 0 forever. Either way it's a
    // real, intentional trade for freshness, not a silent one.
    const eventLoopLagBase = metricsRegistry.getSingleMetric("nodejs_eventloop_lag_seconds");
    if (eventLoopLagBase) await eventLoopLagBase.get();
    const eventLoopLagP99Metric = metricsRegistry.getSingleMetric(
      "nodejs_eventloop_lag_p99_seconds",
    );
    const eventLoopLagP99Values = eventLoopLagP99Metric
      ? (await eventLoopLagP99Metric.get()).values
      : [];
    const eventLoopLagP99 =
      eventLoopLagP99Values.length > 0 && eventLoopLagP99Values[0]
        ? eventLoopLagP99Values[0].value
        : 0;

    // Routers-per-worker max, across this instance's workers. Same
    // staleness shape as above: `routersPerWorker` is normally only
    // refreshed inside the `/metrics/prometheus` route handler
    // (updateWorkerMetrics(), metrics.ts), which this 60s tick never hits.
    // Call that same refresh function directly before reading — exported
    // from metrics.ts for exactly this purpose. Idempotent, so this doesn't
    // disturb a real scrape that happens to land in the same second.
    updateWorkerMetrics(workerManager);
    const routersPerWorkerMetric = await metrics.routersPerWorker.get();
    const routersPerWorkerMax =
      routersPerWorkerMetric.values.length > 0
        ? Math.max(...routersPerWorkerMetric.values.map((v) => v.value))
        : 0;

    // Redis degradation total (platform-security 07) — cumulative, summed
    // across every subsystem/operation label combination. A sustained
    // non-zero rate means a subsystem is quietly running on fallback data.
    const redisDegradationMetric = await metrics.redisDegradations.get();
    const redisDegradationTotal = redisDegradationMetric.values.reduce(
      (sum, v) => sum + v.value,
      0,
    );

    // Socket registration failures (Redis unreachable during auth). Cumulative.
    const socketRegFailuresMetric = await metrics.socketRegistrationFailures.get();
    const socketRegistrationFailures =
      socketRegFailuresMetric.values.length > 0 && socketRegFailuresMetric.values[0]
        ? socketRegFailuresMetric.values[0].value
        : 0;

    // Sentry events dropped client-side by the token bucket. A silently
    // throttling bucket looks healthy everywhere else. Cumulative.
    const sentryDroppedMetric = await metrics.sentryDropped.get();
    const sentryDroppedTotal =
      sentryDroppedMetric.values.length > 0 && sentryDroppedMetric.values[0]
        ? sentryDroppedMetric.values[0].value
        : 0;

    // ticket 32 pt.6: the broadcast (HLS/LL-HLS) transcoder metrics added in
    // pt.3, bridged so fleet alarms can be written against them. Feature-
    // flagged off by default (config.BROADCAST_HLS_ENABLED) — while disabled
    // these gauges legitimately read 0 and the counters never move, which is
    // the correct "transcoder idle" signal, not a reason to skip publishing.

    // FFmpeg transcoder processes currently running on this instance —
    // primary CPU-saturation signal for the transcoder.
    const hlsPublishersActiveMetric = await metrics.hlsPublishersActive.get();
    const hlsPublishersActive =
      hlsPublishersActiveMetric.values.length > 0 && hlsPublishersActiveMetric.values[0]
        ? hlsPublishersActiveMetric.values[0].value
        : 0;

    // FFmpeg exits, split success/failure by the process itself (not by us).
    // Only "unexpected" is alarm-worthy — "expected" is our own SIGKILL
    // (stop() or a debounced restart()) and is a normal, healthy event.
    const hlsPublisherExitsMetric = await metrics.hlsPublisherExits.get();
    let hlsPublisherExitsUnexpected = 0;
    for (const v of hlsPublisherExitsMetric.values) {
      if (v.labels.reason === "unexpected") hlsPublisherExitsUnexpected = v.value;
    }

    // Mixer UDP receive port pool: in-use vs total capacity, so an alarm can
    // express "% of pool used" instead of hard-coding the port range.
    const hlsMixerPortsInUseMetric = await metrics.hlsMixerPortsInUse.get();
    const hlsMixerPortsInUse =
      hlsMixerPortsInUseMetric.values.length > 0 && hlsMixerPortsInUseMetric.values[0]
        ? hlsMixerPortsInUseMetric.values[0].value
        : 0;

    const hlsMixerPortsCapacityMetric = await metrics.hlsMixerPortsCapacity.get();
    const hlsMixerPortsCapacity =
      hlsMixerPortsCapacityMetric.values.length > 0 && hlsMixerPortsCapacityMetric.values[0]
        ? hlsMixerPortsCapacityMetric.values[0].value
        : 0;

    // Port pool exhaustion count. Cumulative is fine — CloudWatch alarms use
    // RATE() math the same way the reverse-pipe counters above do.
    const hlsMixerPortExhaustedMetric = await metrics.hlsMixerPortExhausted.get();
    const hlsMixerPortExhaustedTotal =
      hlsMixerPortExhaustedMetric.values.length > 0 && hlsMixerPortExhaustedMetric.values[0]
        ? hlsMixerPortExhaustedMetric.values[0].value
        : 0;

    // R2 upload/cleanup failures, summed across every `operation` label
    // value — same reduction as RedisDegradationTotal above.
    const hlsUploaderFailuresMetric = await metrics.hlsUploaderFailures.get();
    const hlsUploaderFailuresTotal = hlsUploaderFailuresMetric.values.reduce(
      (sum, v) => sum + v.value,
      0,
    );

    await client.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [
          ...pair("ActiveRooms", activeRooms, "Count", now, dimensions),
          ...pair("ActiveConnections", activeConnections, "Count", now, dimensions),
          ...pair("WorkerCount", workerCount, "Count", now, dimensions),
          ...pair("WorkerCPU", workerCpuPercent, "Percent", now, dimensions),
          ...pair("MaxRoomListeners", maxRoomListeners, "Count", now, dimensions),
          ...pair("ReversePipeSetupSuccess", reverseSetupSuccess, "Count", now, dimensions),
          ...pair("ReversePipeSetupFailure", reverseSetupFailure, "Count", now, dimensions),
          ...pair("EventLoopLagP99Seconds", eventLoopLagP99, "Seconds", now, dimensions),
          ...pair("RoutersPerWorkerMax", routersPerWorkerMax, "Count", now, dimensions),
          ...pair("RedisDegradationTotal", redisDegradationTotal, "Count", now, dimensions),
          ...pair(
            "SocketRegistrationFailures",
            socketRegistrationFailures,
            "Count",
            now,
            dimensions,
          ),
          ...pair("SentryDroppedTotal", sentryDroppedTotal, "Count", now, dimensions),
          ...pair("HlsPublishersActive", hlsPublishersActive, "Count", now, dimensions),
          ...pair(
            "HlsPublisherExitsUnexpected",
            hlsPublisherExitsUnexpected,
            "Count",
            now,
            dimensions,
          ),
          ...pair("HlsMixerPortsInUse", hlsMixerPortsInUse, "Count", now, dimensions),
          ...pair("HlsMixerPortsCapacity", hlsMixerPortsCapacity, "Count", now, dimensions),
          ...pair(
            "HlsMixerPortExhaustedTotal",
            hlsMixerPortExhaustedTotal,
            "Count",
            now,
            dimensions,
          ),
          ...pair("HlsUploaderFailuresTotal", hlsUploaderFailuresTotal, "Count", now, dimensions),
        ],
      }),
    );

    logger.debug(
      {
        activeRooms,
        activeConnections,
        workerCount,
        workerCpuPercent,
        maxRoomListeners,
        reverseSetupSuccess,
        reverseSetupFailure,
        eventLoopLagP99,
        routersPerWorkerMax,
        redisDegradationTotal,
        socketRegistrationFailures,
        sentryDroppedTotal,
        hlsPublishersActive,
        hlsPublisherExitsUnexpected,
        hlsMixerPortsInUse,
        hlsMixerPortsCapacity,
        hlsMixerPortExhaustedTotal,
        hlsUploaderFailuresTotal,
      },
      "CloudWatch metrics published",
    );
  } catch (err) {
    // Don't crash — just log the error
    logger.warn({ err }, "Failed to publish CloudWatch metrics");
  }
}

/**
 * Start the CloudWatch metrics publisher
 */
export async function startCloudWatchPublisher(
  roomManager: RoomManager,
  workerManager: WorkerManager,
): Promise<void> {
  // Skip in development or when explicitly disabled
  const enabled = process.env.CLOUDWATCH_ENABLED;
  if (config.NODE_ENV === "development" || enabled === "false") {
    logger.info("CloudWatch metrics publishing disabled (development mode)");
    return;
  }

  logger.info({ instanceId: config.INSTANCE_ID }, "CloudWatch metrics publisher starting");

  // Publish immediately, then every 60 seconds
  await publishMetrics(roomManager, workerManager);

  publishHandle = setInterval(
    () => void publishMetrics(roomManager, workerManager),
    PUBLISH_INTERVAL_MS,
  );
}

/**
 * Stop the CloudWatch metrics publisher
 */
export function stopCloudWatchPublisher(): void {
  if (publishHandle) {
    clearInterval(publishHandle);
    publishHandle = null;
  }
}
