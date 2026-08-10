/**
 * Event Ingest Route
 * HTTP endpoint for receiving Laravel events via direct authenticated POST.
 *
 * Replaces Redis pub/sub for Laravel → MSAB event delivery. This HTTP path is
 * the legacy transport: ticket 26's SQS consumer (queue-consumer.ts) shares
 * the same `ingestEnvelope` pipeline, and once the queue is observed carrying
 * production traffic the operator retires this route via
 * EVENT_HTTP_INGEST_ENABLED=false (ticket 28 — reversible until the
 * observation window closes).
 *
 * NOTE: all SNS handling is gone. SubscriptionConfirmation auto-confirmation
 * was deleted 2026-08-01 (platform-security/02 — blind SSRF: it fetched an
 * attacker-supplied URL before auth). The Notification-envelope unwrap,
 * text/plain content-type parser, and `?key=` query-param auth were deleted
 * by ticket 28 (2026-08-11) along with the SNS topic itself
 * (terraform modules/sns): SNS never carried production traffic — Laravel
 * always delivered via direct POST — and the account the topic targeted is
 * dead. Re-adopting SNS would require, at minimum, message signature
 * verification (`SigningCertURL` + `Signature`), a host allowlist for any
 * fetched URL, and bounded fetches — see platform-security/02 for the full
 * writeup.
 */
import type { FastifyPluginAsync } from "fastify";
import type { Redis } from "ioredis";
import type { EventRouter } from "@src/integrations/laravel/event-router.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";
import { config } from "@src/config/index.js";
import { parseVendorTraceId, setVendorTraceId, withCorrelation } from "./correlation.js";
import { z } from "zod";
import { matchesRotatableKey, parsePreviousKeys } from "@src/shared/keyRotation.js";
import { metrics } from "./metrics.js";
import { buildDedupKey, claimEvent, releaseClaim } from "./event-dedup.js";

/** Zod schema for the Laravel event envelope. */
const EventPayloadSchema = z.object({
  event: z.string(),
  user_id: z.number().nullable().default(null),
  room_id: z.number().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
  /**
   * NOT defaulted. This is the version the ordering guards compare against, and
   * defaulting it to `new Date().toISOString()` would stamp every unversioned
   * event with its ARRIVAL time — which encodes the reordering the guards
   * exist to undo, letting a late replay outrank the event it is replaying.
   * Absent stays absent so the guards can skip rather than be misled.
   */
  timestamp: z.string().optional(),
  correlation_id: z.string().default("unknown"),
});

/**
 * F-40: bound how many Laravel events route concurrently. A Laravel burst
 * (gift cascade, agency dissolve, force-disconnect sweep) would otherwise
 * flood the event loop — ping/pong timeouts → mass socket disconnects during
 * the burst. Over the cap we return 503 so the SNS delivery policy retries
 * with backoff instead of piling more work on.
 *
 * Shared across BOTH transports (HTTP route + SQS consumer, ticket 26): the
 * cap protects the event loop, and the event loop is one.
 */
const MAX_CONCURRENT_EVENTS = 100;
let inFlightEvents = 0;

/**
 * Ticket 26 (seam 2): the transport-agnostic outcome of ingesting one
 * envelope. Both the HTTP route and the queue consumer map these to their own
 * transport semantics (HTTP status codes vs delete/keep-on-queue).
 */
export type IngestOutcome =
  | { kind: "invalid"; errors: Record<string, string[] | undefined> }
  | { kind: "capacity" }
  | { kind: "duplicate" }
  | { kind: "ok"; delivered: boolean; targetCount: number };

/** Minimal logger shape both fastify.log and the app Logger satisfy. */
interface IngestLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Ticket 26 (seam 2): the ONE envelope-handling pipeline — schema validation,
 * concurrency shed, at-least-once dedup, correlation adoption, routing, and
 * claim release on throw. Every transport MUST route through this function;
 * a second ingest path would let the transports drift.
 *
 * Transport-specific concerns stay OUT of here: HTTP auth, SNS envelope
 * unwrapping, and content-type parsing belong to the HTTP route; message
 * deletion/redelivery belongs to the queue consumer.
 */
export async function ingestEnvelope(
  raw: unknown,
  deps: {
    eventRouter: EventRouter;
    redis?: Redis | undefined;
    log: IngestLogger;
    /** Secondary vendor trace header (HTTP transport only) — see route. */
    vendorTraceId?: string | undefined;
  },
): Promise<IngestOutcome> {
  const { eventRouter, redis, log, vendorTraceId } = deps;

  const result = EventPayloadSchema.safeParse(raw);
  if (!result.success) {
    log.warn(
      { errors: result.error.flatten().fieldErrors },
      "Invalid event payload",
    );
    return { kind: "invalid", errors: result.error.flatten().fieldErrors };
  }

  const event: LaravelEvent = result.data;

  // F-40: backpressure — shed load past the concurrency cap so a burst
  // can't saturate the event loop.
  if (inFlightEvents >= MAX_CONCURRENT_EVENTS) {
    log.warn(
      { inFlight: inFlightEvents, event: event.event },
      "Event ingest at capacity — shedding",
    );
    return { kind: "capacity" };
  }

  // --- GATE: at-least-once deduplication ---
  //
  // Deliberately placed AFTER the capacity shed above. Claiming the event
  // first would mark a shed event as seen, and the sender's retry of that
  // very event would then be dropped at this gate — silent event loss
  // precisely when load is highest. With the shed ahead of it, no failure
  // path exists downstream of the claim except a routing throw, which
  // releases it.
  //
  // See event-dedup.ts for why the key is not `correlation_id` alone.
  const dedupKey = redis ? buildDedupKey(event) : null;
  if (redis && dedupKey && !(await claimEvent(redis, dedupKey))) {
    metrics.laravelEventsDeduplicated.inc({ event_type: event.event });
    log.info(
      {
        event: event.event,
        userId: event.user_id,
        roomId: event.room_id,
        correlationId: event.correlation_id,
      },
      "Event ingest: duplicate suppressed",
    );
    return { kind: "duplicate" };
  }

  log.info(
    {
      event: event.event,
      userId: event.user_id,
      roomId: event.room_id,
      correlationId: event.correlation_id,
    },
    "Event ingest: routing event",
  );

  // --- Route Event ---
  //
  // Adopt the sender's identifier as the ambient one for the whole routing
  // operation — a Laravel request and the socket delivery it caused appear as
  // one trace. The schema defaults `correlation_id` to the literal "unknown"
  // when absent, which resolveCorrelationId treats as missing and replaces
  // with a minted id.
  inFlightEvents++;
  try {
    const routingResult = await withCorrelation(event.correlation_id, () => {
      // Secondary field on the same operation — see the HTTP route's header read.
      if (vendorTraceId !== undefined) setVendorTraceId(vendorTraceId);
      return eventRouter.route(event);
    });

    return {
      kind: "ok",
      delivered: routingResult.delivered,
      targetCount: routingResult.targetCount,
    };
  } catch (err) {
    // Hand the claim back so a retry of this envelope is allowed through.
    // Insurance only: `route()` catches everything internally and returns a
    // result object, so this covers a throw from outside its own try/catch.
    // A returned `{delivered:false}` is a terminal OUTCOME (e.g. the user
    // has no sockets), not a failure — it must keep its claim.
    if (redis && dedupKey) await releaseClaim(redis, dedupKey);
    throw err;
  } finally {
    inFlightEvents--;
  }
}

export const createEventIngestRoutes = (
  eventRouter: EventRouter,
  /**
   * Backing store for the at-least-once dedup gate. Optional so the gate is
   * strictly additive: omit it and ingest behaves exactly as it did before,
   * which keeps every existing caller and test valid. Production always passes
   * it (see infrastructure/server.ts).
   */
  redis?: Redis,
): FastifyPluginAsync => {
  return async (fastify) => {
    /**
     * POST /api/events
     *
     * Accepts events from direct HTTP POST from Laravel only (header auth).
     * SNS delivery — and its `?key=` query-param auth — was retired by
     * ticket 28; see the file header.
     */
    fastify.post("/api/events", async (request, reply) => {
      fastify.log.info(
        { contentType: request.headers["content-type"] },
        "Event ingest: request received",
      );

      // Ticket 28: operator kill switch. Flipped to false only after the SQS
      // transport is observed carrying production traffic; 410 (not 404) so a
      // misconfigured sender surfaces loudly rather than looking like a bad URL.
      if (!config.EVENT_HTTP_INGEST_ENABLED) {
        return reply.code(410).send({
          status: "error",
          message: "HTTP event ingest retired — use the queue transport",
        });
      }

      // --- Authentication ---
      // Direct POST from Laravel sends the X-Internal-Key header. This is the
      // ONLY accepted credential: the `?key=` query-param fallback (SNS could
      // not send custom headers) died with the SNS path, so a leaked access
      // log line no longer leaks the credential.
      const internalKey = request.headers["x-internal-key"] as
        | string
        | undefined;

      if (!matchesRotatableKey(internalKey, config.LARAVEL_INTERNAL_KEY, parsePreviousKeys(config.LARAVEL_INTERNAL_KEY_PREVIOUS))) {
        return reply
          .code(401)
          .send({ status: "error", message: "Unauthorized" });
      }

      // observability-audio-quality 11: the API's error-tracker integration stamps every
      // outgoing HTTP call — including this one — with its own `sentry-trace` header,
      // regardless of the correlation_id already in the envelope below. READ only: this
      // service never mints that header itself and never turns it into a span (span
      // sampling stays off, see instrument.ts). Absent/malformed is silently undefined —
      // it is a secondary field, losing it costs nothing the envelope's correlation_id
      // doesn't already cover.
      const vendorTraceId = parseVendorTraceId(request.headers["sentry-trace"]);

      // --- Parse Event ---
      const raw: unknown = request.body;

      // --- Shared pipeline (seam 2) — one core for HTTP and queue transports ---
      const outcome = await ingestEnvelope(raw, {
        eventRouter,
        redis,
        log: fastify.log,
        vendorTraceId,
      });

      switch (outcome.kind) {
        case "invalid":
          return reply.code(422).send({
            status: "error",
            message: "Invalid event: schema validation failed",
            errors: outcome.errors,
          });
        case "capacity":
          // 503 so the sender retries with backoff instead of piling on.
          return reply.code(503).header("Retry-After", "1").send({
            status: "error",
            message: "Event ingest at capacity, retry",
          });
        case "duplicate":
          // 200, not 4xx: a non-2xx makes the sender retry the delivery we
          // just suppressed, turning one duplicate into a retry loop.
          return reply
            .code(200)
            .send({ status: "ok", duplicate: true, delivered: false, target_count: 0 });
        case "ok":
          return reply.code(200).send({
            status: "ok",
            delivered: outcome.delivered,
            target_count: outcome.targetCount,
          });
      }
    });
  };
};
