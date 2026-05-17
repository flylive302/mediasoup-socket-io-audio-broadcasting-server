/**
 * F-67: Revocation backfill poller.
 *
 * The primary revocation path is real-time SNS (Laravel → MSAB → local Redis
 * `auth:user_revoked:{userId}`), but it is fire-and-forget: if this instance
 * is unreachable when the emit fires, it never learns of the revocation and
 * the leaked JWT stays valid for its full lifetime. This poller periodically
 * pulls the durable backfill log from Laravel and reconciles any revocations
 * it missed.
 *
 * The key write here MUST stay byte-identical to EventRouter.writeRevocationKey
 * (same key, value = String(revokedAt) in unix seconds, EX = JWT max age),
 * otherwise jwtValidator's `payload.iat < Number(revokedAt)` check silently
 * ignores backfilled keys.
 */
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import { config } from "@src/config/index.js";

const CURSOR_KEY = "msab:revocation_poll:since";
const POLL_INTERVAL_MS = 60_000;
/** Re-scan a window before the cursor so boundary entries are never missed. */
const OVERLAP_SECONDS = 120;

export class RevocationBackfillPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly laravelClient: LaravelClient,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.info("Revocation backfill poller started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.running) return; // skip if a slow poll is still in flight
    this.running = true;
    try {
      const cursor = Number((await this.redis.get(CURSOR_KEY)) ?? "0");
      const since = Math.max(0, cursor - OVERLAP_SECONDS);

      const { revoked, server_time } =
        await this.laravelClient.getRevokedSince(since);

      for (const { user_id, revoked_at } of revoked) {
        // Identical to EventRouter.writeRevocationKey — keep in sync.
        await this.redis.set(
          `auth:user_revoked:${user_id}`,
          String(revoked_at),
          "EX",
          config.JWT_MAX_AGE_SECONDS,
        );
      }

      await this.redis.set(CURSOR_KEY, String(server_time));

      if (revoked.length > 0) {
        this.logger.info(
          { reconciled: revoked.length, since },
          "Revocation backfill: reconciled missed revocations",
        );
      }
    } catch (err) {
      // Non-blocking — primary SNS path still handles real-time revocation.
      this.logger.warn({ err }, "Revocation backfill poll failed");
    } finally {
      this.running = false;
    }
  }
}
