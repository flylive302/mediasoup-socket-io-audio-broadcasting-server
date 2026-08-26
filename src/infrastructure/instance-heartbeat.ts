/**
 * Instance heartbeat — keeps THIS box present in Laravel's placement registry
 * (aws-production/24 follow-up).
 *
 * Why: `InstanceHealthRegistry` was fed only by room-status posts. A freshly
 * booted box has no rooms → never posts → is invisible to placement → never
 * gets rooms. Observed 2026-08-26: after the cascade-off refresh the fleet ran
 * on one box and the second drain re-pinned 0 of 398 rooms (no healthy target).
 *
 * REACT stage: fire-and-forget, never throws, never blocks boot or shutdown.
 * A draining instance keeps heartbeating — the registry preserves `draining`
 * on heartbeat, and its rooms are still live until the drain finishes.
 */
import { config } from "../config/index.js";
import { logger } from "./logger.js";

export const INSTANCE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface InstanceHeartbeatClient {
  sendInstanceHeartbeat(region: string): Promise<boolean>;
}

export interface InstanceHeartbeatHandle {
  stop(): void;
}

export function startInstanceHeartbeat(
  client: InstanceHeartbeatClient,
  intervalMs: number = INSTANCE_HEARTBEAT_INTERVAL_MS,
): InstanceHeartbeatHandle {
  const region = config.AWS_REGION;

  const beat = (): void => {
    client.sendInstanceHeartbeat(region).catch((error: unknown) => {
      logger.warn({ error }, "Instance heartbeat threw");
    });
  };

  beat();
  const handle = setInterval(beat, intervalMs);
  handle.unref();

  logger.info({ intervalMs, region }, "Instance heartbeat started");

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
