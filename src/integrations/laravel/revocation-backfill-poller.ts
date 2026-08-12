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
import { recordRedisDegradation } from "@src/shared/redis-degradation.js";

const CURSOR_KEY = "msab:revocation_poll:since";
const POLL_INTERVAL_MS = 60_000;
/** Re-scan a window before the cursor so boundary entries are never missed. */
const OVERLAP_SECONDS = 120;

/**
 * Wrapper thrown by `redisStep()` so the catch site can tell a Redis failure
 * from a Laravel one without pattern-matching on the message. The original is
 * kept on `cause`, which is what the log line serialises.
 */
class RedisStepError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`Redis ${operation} failed during revocation backfill`, { cause });
    this.name = "RedisStepError";
  }
}

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

  /**
   * Runs one Redis call, attributing a failure to Redis **at the throw site**
   * rather than at the catch site, then rethrowing unchanged-in-effect.
   *
   * aws-production 32: the catch below used to record the degradation for the
   * whole `try`, which also spans `getRevokedSince()` — an HTTP call. On any
   * environment whose `LARAVEL_API_URL` is unreachable that booked a **Laravel**
   * outage as a **Redis** one, once every 60 s forever, against a counter whose
   * documented steady state is zero and which has a fleet-wide alarm on it.
   *
   * platform-security 07 saw this and left it, reasoning that splitting the try
   * would change control flow. Attributing here does not: every error still
   * propagates to the same catch, still aborts the poll, still logs once. One
   * failed poll still produces exactly one increment, because the first failure
   * rethrows — the rate semantics operators alert on are unchanged.
   */
  private async redisStep<T>(
    operation: "read" | "write",
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      recordRedisDegradation("revocation-backfill", operation);
      throw new RedisStepError(operation, err);
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.running) return; // skip if a slow poll is still in flight
    this.running = true;
    try {
      const cursor = Number(
        (await this.redisStep("read", () => this.redis.get(CURSOR_KEY))) ?? "0",
      );
      const since = Math.max(0, cursor - OVERLAP_SECONDS);

      const { revoked, server_time } =
        await this.laravelClient.getRevokedSince(since);

      for (const { user_id, revoked_at } of revoked) {
        // Identical to EventRouter.writeRevocationKey — keep in sync.
        await this.redisStep("write", () =>
          this.redis.set(
            `auth:user_revoked:${user_id}`,
            String(revoked_at),
            "EX",
            config.JWT_MAX_AGE_SECONDS,
          ),
        );
      }

      await this.redisStep("write", () =>
        this.redis.set(CURSOR_KEY, String(server_time)),
      );

      if (revoked.length > 0) {
        this.logger.info(
          { reconciled: revoked.length, since },
          "Revocation backfill: reconciled missed revocations",
        );
      }
    } catch (err) {
      // Non-blocking — primary SNS path still handles real-time revocation.
      // The degradation counter is recorded in redisStep(), so a Laravel-side
      // failure reaching here emits no Redis metric; it is already counted as
      // `flylive_laravel_api_calls_total{endpoint="users/revoked",status="error"}`
      // by LaravelClient.get(), which also captures it to Sentry.
      // `phase` is what lets an operator tell the two apart from the log alone.
      const phase = err instanceof RedisStepError ? "redis" : "laravel";
      this.logger.warn({ err, phase }, "Revocation backfill poll failed");
    } finally {
      this.running = false;
    }
  }
}
