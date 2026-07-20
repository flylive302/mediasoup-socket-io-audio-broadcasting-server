/**
 * Sentry initialisation.
 *
 * This module MUST be loaded through Node's `--import` flag, never imported
 * from `index.ts`:
 *
 *   node --import ./dist/instrument.js dist/index.js
 *
 * Under ESM every `import` in a module is hoisted and evaluated before any of
 * that module's own statements run, so a `import "./instrument.js"` at the top
 * of `index.ts` would let Fastify/undici load BEFORE `Sentry.init()` had a
 * chance to patch them. The install would look healthy and silently
 * under-report. `NODE_OPTIONS` was rejected for the opposite reason: it is
 * invisible at the CMD and applies container-wide.
 *
 * Keep this module's import surface MINIMAL — config (zod/dotenv/node:os),
 * metrics (prom-client) and two pure helpers. Pulling in fastify, socket.io or
 * the Laravel client here would re-create the exact pre-init patching problem
 * the `--import` approach exists to prevent.
 *
 * See docs/issues/msab-sentry/prd-msab-sentry.md §4.
 */
import * as Sentry from "@sentry/node";
import { config } from "./config/index.js";
import { metrics } from "./infrastructure/metrics.js";
import { tokenBucket } from "./infrastructure/sentry/token-bucket.js";
import { scrubSecrets } from "./infrastructure/sentry/scrub.js";

/**
 * Client-side quota control (§9). Dropping happens here rather than at
 * Sentry's edge so it survives the fleet-wide bad-deploy case, where a
 * server-side limit would already have counted the events.
 */
const bucket = tokenBucket({
  capacity: config.SENTRY_BUCKET_CAPACITY,
  refillPerHour: config.SENTRY_BUCKET_REFILL_HOUR,
});

const dsn = config.SENTRY_DSN;

if (!dsn) {
  // The logger is not safe to import here (see the import-surface note above),
  // so a plain warn it is.
  console.warn("[sentry] SENTRY_DSN not set — error reporting disabled");
} else {
  Sentry.init({
    dsn,
    // exactOptionalPropertyTypes: `release` is `string | undefined` in config
    // but `release?: string` in the SDK, so it has to be spread in.
    ...(config.SENTRY_RELEASE ? { release: config.SENTRY_RELEASE } : {}),
    environment: config.SENTRY_ENVIRONMENT,

    // §8 — identify the user, never describe them. No PII, and no local
    // variables: frames in authMiddleware/jwtValidator hold the raw JWT and
    // bootstrap frames hold JWT_SECRET / LARAVEL_INTERNAL_KEY /
    // REDIS_PASSWORD. One missed regex would cost a fleet-wide rotation.
    sendDefaultPii: false,
    includeLocalVariables: false,

    // The token bucket in `beforeSend` is the real volume control; sampling
    // here would drop events blindly instead of budget-aware.
    sampleRate: 1.0,

    // NO TRACING IN V1 — deliberate deviation from spec §4, decided
    // 2026-07-20. The spec's `tracesSampler` branched on socket event names
    // (room:join / cascade: / transport:), but §7 itself establishes there is
    // no Socket.IO auto-instrumentation, so no span is ever named those — it
    // would only have shipped Fastify/HTTP plumbing traces. Worse, spans are
    // NOT bounded by the token bucket below (that gates errors only), and the
    // $20 PAYG budget is shared first-come-first-served across products, so a
    // span overrun could consume the very error budget §3 is built on.
    // Errors-only keeps that budget model honest. Revisit at the §12
    // one-week re-check, once real error volume is measured.

    integrations: (defaults) => [
      ...defaults.filter(
        (integration) =>
          // MSAB drives its own unhandledRejection circuit breaker
          // (src/index.ts) and captures with count/threshold context. Leaving
          // the default integration on would double-report every rejection.
          integration.name !== "OnUnhandledRejection" &&
          // Would double-report mediasoup worker deaths, which
          // worker.manager.ts already captures as fatal.
          integration.name !== "ChildProcess" &&
          // Replaced below with the explicit option.
          integration.name !== "OnUncaughtException",
      ),
      // Verified against @sentry/node 10.66.0: this already defaults to
      // `false`, contrary to the docs. Set explicitly so a future default
      // flip cannot start racing MSAB's own handler to exit the process.
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: false,
      }),
    ],

    beforeSend(event) {
      // Fatal events BYPASS the bucket. Everything else is budgeted, but a
      // crash is inherently bounded (a process dies once, the rejection
      // threshold fires once, workers die rarely) while error bursts are not
      // — and a burst is exactly when a crash happens. Gating fatals would
      // drop the one event class this whole epic exists to surface
      // ("unexplained crashes and restarts", §1 pain #1) precisely when it
      // matters most.
      if (event.level !== "fatal" && !bucket.take()) {
        metrics.sentryDropped.inc();
        return null;
      }

      // Stamped here, not at init: INSTANCE_ID is resolved asynchronously from
      // IMDSv2 by initializeConfig() long after this module is evaluated, and
      // init must not block on it. `config` is a single shared module instance
      // across both build entries (verified — see INDEX.md), so by the time any
      // event fires the resolved id is visible here. Unconditional override:
      // the SDK's default is the container hostname, which is NOT the id the
      // Prometheus/CloudWatch telemetry for this fleet is keyed on.
      if (config.INSTANCE_ID) {
        event.server_name = config.INSTANCE_ID;
      }
      event.tags = { region: config.AWS_REGION, ...event.tags };

      const headers = event.request?.headers;
      if (headers) {
        delete headers["authorization"];
        delete headers["cookie"];
        delete headers["x-internal-key"];
      }
      return scrubSecrets(event);
    },
  });
}
