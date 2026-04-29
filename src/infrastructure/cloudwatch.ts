/**
 * CloudWatch Metrics Publisher
 *
 * Publishes custom application metrics to AWS CloudWatch for auto-scaling decisions.
 * - Namespace: FlyLive/MSAB
 * - Metrics: ActiveRooms, ActiveConnections, WorkerCount, WorkerCPU
 * - Resolution: Standard (60s interval)
 *
 * Disabled when:
 * - NODE_ENV=development
 * - CLOUDWATCH_ENABLED=false
 * - No IAM instance profile (logs warning once, then silently skips)
 */
import { config } from "@src/config/index.js";
import { logger } from "./logger.js";
import { metrics } from "./metrics.js";
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

    await client.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [
          {
            MetricName: "ActiveRooms",
            Value: activeRooms,
            Unit: "Count",
            Timestamp: now,
            Dimensions: dimensions,
          },
          {
            MetricName: "ActiveConnections",
            Value: activeConnections,
            Unit: "Count",
            Timestamp: now,
            Dimensions: dimensions,
          },
          {
            MetricName: "WorkerCount",
            Value: workerCount,
            Unit: "Count",
            Timestamp: now,
            Dimensions: dimensions,
          },
          {
            MetricName: "WorkerCPU",
            Value: workerCpuPercent,
            Unit: "Percent",
            Timestamp: now,
            Dimensions: dimensions,
          },
          {
            MetricName: "MaxRoomListeners",
            Value: maxRoomListeners,
            Unit: "Count",
            Timestamp: now,
            Dimensions: dimensions,
          },
          {
            MetricName: "ReversePipeSetupSuccess",
            Value: reverseSetupSuccess,
            Unit: "Count",
            Timestamp: now,
            Dimensions: dimensions,
          },
          {
            MetricName: "ReversePipeSetupFailure",
            Value: reverseSetupFailure,
            Unit: "Count",
            Timestamp: now,
            Dimensions: dimensions,
          },
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
