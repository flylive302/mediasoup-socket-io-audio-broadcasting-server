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
let instanceId = "unknown";

/**
 * Resolve the EC2 instance ID from instance metadata (IMDSv2)
 */
async function resolveInstanceId(): Promise<string> {
  try {
    // Get IMDSv2 token
    const tokenRes = await fetch(
      "http://169.254.169.254/latest/api/token",
      {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        signal: AbortSignal.timeout(2000),
      },
    );
    const token = await tokenRes.text();

    // Get instance ID
    const idRes = await fetch(
      "http://169.254.169.254/latest/meta-data/instance-id",
      {
        headers: { "X-aws-ec2-metadata-token": token },
        signal: AbortSignal.timeout(2000),
      },
    );
    return await idRes.text();
  } catch {
    // Not running on EC2 — use hostname as fallback
    const os = await import("os");
    return os.hostname();
  }
}

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
    const dimensions = [{ Name: "InstanceId", Value: instanceId }];

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
        ],
      }),
    );

    logger.debug(
      { activeRooms, activeConnections, workerCount, workerCpuPercent },
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

  // Resolve instance ID
  instanceId = await resolveInstanceId();
  logger.info({ instanceId }, "CloudWatch metrics publisher starting");

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
