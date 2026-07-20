/**
 * REACT-stage error reporting.
 *
 * REACT work is fire-and-forget by design: buffers flushing to Laravel, cache
 * writes, activity records, cascade relays. When one fails the user-facing
 * action has already succeeded, so the failure is swallowed after a log line —
 * which is exactly why these are the "silent user-facing failures" this epic
 * exists to surface (spec §1 pain #3).
 *
 * There are ~38 such sites. A curated subset was rejected: new REACT code
 * would have to opt in by memory, and the ones that matter are the ones nobody
 * thought to add.
 *
 * DEDUPE IS REQUIRED, NOT OPTIONAL. The token bucket allows ~30 events/hour
 * per process. Un-deduped REACT chatter — one failing dependency retried in a
 * loop — would drain that budget in seconds and starve the real crashes the
 * bucket exists to protect. Dedupe runs BEFORE the bucket is consulted (the
 * bucket lives in beforeSend), so a suppressed duplicate costs no token.
 */
import * as Sentry from "@sentry/node";
import { logger as rootLogger, type Logger } from "@src/infrastructure/logger.js";
import { seenRecently } from "@src/infrastructure/sentry/dedupe.js";

/**
 * Keyed by call site (`msg` is a unique literal per site) PLUS the error's own
 * message, so a site that starts failing a *different* way still reports.
 */
function reactDedupeKey(msg: string, err: unknown): string {
  const detail =
    err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return `react|${msg}|${detail}`;
}

/**
 * Log a REACT-stage failure exactly as before, then report it to Sentry once
 * per dedupe window.
 *
 * @param err   The caught error.
 * @param ctx   Structured context — ids and numbers only, never free text.
 *              `userId` and `roomId` are promoted to the Sentry user/tag;
 *              everything else becomes event `extra`.
 * @param msg   The log message. MUST be a unique literal per call site — it
 *              doubles as the dedupe key and the Sentry issue grouping hint.
 * @param opts  `level` MUST match the level the call site already used, and
 *              `logger` MUST be the instance it already logged through (many
 *              classes here log via an injected `this.logger`). This migration
 *              adds a Sentry report; it must not perturb a single existing log
 *              line, because Grafana and CloudWatch alerts key on both.
 */
export function reactError(
  err: unknown,
  ctx: Record<string, unknown>,
  msg: string,
  opts: { level?: "debug" | "warn" | "error"; logger?: Logger } = {},
): void {
  const { level = "warn", logger = rootLogger } = opts;

  // Byte-for-byte the original call site's log line.
  if (level === "error") {
    logger.error({ err, ...ctx }, msg);
  } else if (level === "debug") {
    logger.debug({ err, ...ctx }, msg);
  } else {
    logger.warn({ err, ...ctx }, msg);
  }

  // Telemetry must never break a REACT path that is already handling a
  // failure — this whole block is best-effort.
  try {
    if (seenRecently(reactDedupeKey(msg, err))) return;

    const { userId, roomId, ...rest } = ctx;

    Sentry.withScope((scope) => {
      if (userId !== undefined && userId !== null) {
        scope.setUser({ id: String(userId) });
      }
      scope.setTags({
        stage: "react",
        ...(roomId !== undefined && roomId !== null
          ? { room_id: String(roomId) }
          : {}),
      });
      // `react_site` is the stable grouping handle; the raw error message
      // alone would split one failing dependency across many issues.
      scope.setExtras({ ...rest, react_site: msg });
      scope.setFingerprint(["react", msg]);
      Sentry.captureException(err, { level: "warning" });
    });
  } catch (sentryErr) {
    logger.warn({ err: sentryErr }, "Sentry REACT capture failed");
  }
}

