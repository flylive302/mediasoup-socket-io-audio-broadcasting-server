/**
 * ⚠️ TEMPORARY — BRANCH-ONLY. DO NOT MERGE TO `master`.
 *
 * Deliberate-failure probes for the one-window verification of
 * docs/issues/msab-observability-hardening tickets 01 and 02:
 *
 *   01 — do production stack traces de-minify to `src/**.ts`?
 *   02 — does an uncaught exception report to Sentry before the process dies?
 *
 * Both probes exist because the two real production issues (NODE-MSAB-1/-2)
 * originate inside `@socket.io/redis-adapter` and carry ZERO first-party
 * frames, so they can neither prove nor disprove the sourcemap upload.
 *
 * Operator steps: docs/issues/msab-observability-hardening/CRITERIA-01-02-window.md
 *
 * Gated by `X-Internal-Key`, matching /admin/drain (see drain.ts). That is the
 * only gate: this file must never reach master, so a second flag would add a
 * failure mode without adding safety. Restoring the instance (Step 5 of the
 * checklist) is what removes these routes.
 */
import type { FastifyPluginAsync } from "fastify";
import * as Sentry from "@sentry/node";

import { config } from "@src/config/index.js";
import { logger } from "./logger.js";

/**
 * Nested so the captured stack carries MORE than one first-party frame —
 * a single frame could plausibly resolve by luck; two proves the mapping.
 */
const raiseProbeFailure = (): never => {
  throw new Error("sentry-probe: deliberate handled failure (ticket 01)");
};

const runSourcemapProbe = (): void => {
  raiseProbeFailure();
};

export const createSentryProbeRoutes = (): FastifyPluginAsync => {
  return async (fastify) => {
    /**
     * POST /admin/probe/handled — ticket 01.
     *
     * A caught throw, reported the same way handler.utils.ts reports handler
     * exceptions. Goes through the token bucket (capacity 20), so check
     * `flylive_sentry_dropped_total` on /metrics before and after: a drained
     * bucket swallows this silently and looks exactly like a broken sourcemap.
     */
    fastify.post("/admin/probe/handled", async (request, reply) => {
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      if (internalKey !== config.LARAVEL_INTERNAL_KEY) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      try {
        runSourcemapProbe();
      } catch (err) {
        Sentry.withScope((scope) => {
          scope.setTags({ probe: "sourcemap", stage: "execute" });
          Sentry.captureException(err);
        });
        logger.warn({ err }, "sentry-probe: handled probe fired (ticket 01)");
      }

      return reply.code(200).send({
        status: "ok",
        probe: "handled",
        release: config.SENTRY_RELEASE ?? null,
        note: "Check node-msab for src/**.ts frames at this release.",
      });
    });

    /**
     * POST /admin/probe/fatal — ticket 02. KILLS THE PROCESS.
     *
     * The throw is deferred into a timer callback deliberately. A throw in
     * this route body — or in any createHandler body — is caught and reported
     * as a HANDLED error (handler.utils.ts wraps every handler in try/catch),
     * which never reaches process.on("uncaughtException") and would report a
     * green pass while testing none of the crash path.
     *
     * Expected: index.ts's handler runs captureAndFlush(..., level "fatal",
     * tags.path "uncaughtException") BEFORE the shutdown attempt, with
     * SENTRY_FLUSH_MS (2s) inside a hardcoded 3s force-exit.
     *
     * Only fire this once the instance is drained AND the LB has dropped it
     * (~45s after /health starts returning 503).
     */
    fastify.post("/admin/probe/fatal", async (request, reply) => {
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      if (internalKey !== config.LARAVEL_INTERNAL_KEY) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      logger.warn(
        { flushMs: config.SENTRY_FLUSH_MS },
        "sentry-probe: fatal probe armed — process will exit (ticket 02)",
      );

      // Reply first: the response must leave before the process dies, or the
      // operator cannot tell "probe fired" from "route unreachable".
      setTimeout(() => {
        throw new Error("sentry-probe: deliberate uncaught exception (ticket 02)");
      }, 250);

      return reply.code(202).send({
        status: "accepted",
        probe: "fatal",
        release: config.SENTRY_RELEASE ?? null,
        note: "Process exits in ~250ms. Expect level:fatal, tags.path:uncaughtException.",
      });
    });
  };
};
