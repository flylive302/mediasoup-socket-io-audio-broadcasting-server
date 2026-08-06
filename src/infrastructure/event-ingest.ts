/**
 * Event Ingest Route
 * HTTP endpoint for receiving Laravel events via AWS SNS (or direct POST).
 *
 * Replaces Redis pub/sub for Laravel → MSAB event delivery.
 * Handles:
 *  - SNS Notification, raw or enveloped message delivery (event JSON)
 *  - Direct POST from Laravel (same JSON format)
 *
 * NOTE: SNS SubscriptionConfirmation auto-confirmation was deleted (platform-security/02,
 * 2026-08-01) — it fetched an attacker-supplied URL before authentication ran. See the
 * comment above the auth check below for what re-adding it safely would require.
 */
import type { FastifyPluginAsync } from "fastify";
import type { Redis } from "ioredis";
import type { EventRouter } from "@src/integrations/laravel/event-router.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";
import { config } from "@src/config/index.js";
import { withCorrelation } from "./correlation.js";
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
 */
const MAX_CONCURRENT_EVENTS = 100;
let inFlightEvents = 0;

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
    // SNS sends requests with Content-Type: text/plain containing JSON
    // Fastify only parses application/json by default
    fastify.addContentTypeParser(
      "text/plain",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(null, body);
        }
      },
    );

    /**
     * POST /api/events
     *
     * Accepts events from:
     * 1. AWS SNS Notification delivery (raw or enveloped)
     * 2. Direct HTTP POST from Laravel
     */
    fastify.post("/api/events", async (request, reply) => {
      const snsMessageType = request.headers["x-amz-sns-message-type"];

      fastify.log.info(
        {
          snsMessageType: snsMessageType ?? "none",
          contentType: request.headers["content-type"],
        },
        "Event ingest: request received",
      );

      // --- Authentication ---
      // Direct POST from Laravel sends X-Internal-Key header.
      // SNS sends the key as ?key= query parameter (SNS cannot send custom headers).
      //
      // SECURITY (platform-security/02, 2026-08-01): this route used to auto-confirm AWS SNS
      // subscriptions here — whenever `x-amz-sns-message-type: SubscriptionConfirmation` was
      // present, it fetched the request body's `SubscribeURL` BEFORE the auth check below ran.
      // The message-type header is attacker-settable and was never verified against anything,
      // so any unauthenticated caller on the internet could make this server fetch an
      // arbitrary URL (blind SSRF). The branch has been deleted outright — not reordered —
      // because Laravel never used SNS (it delivers events via direct authenticated POST) and
      // the AWS account the topic would have lived in is dead. See
      // docs/issues/platform-security/02-delete-the-sns-confirmation-branch.md for the full
      // writeup.
      //
      // If SNS delivery is ever re-adopted, the message-type header must still never be
      // trusted alone. Re-adding auto-confirmation safely requires, at minimum:
      //   1. SNS message signature verification (`SigningCertURL` + `Signature`) before
      //      trusting anything in the body.
      //   2. A host allowlist for `SubscribeURL` / `SigningCertURL` (must be a real AWS SNS
      //      endpoint for the expected region — not attacker-controlled).
      //   3. A bounded fetch with a timeout — never an unbounded `fetch()`.
      const internalKey =
        (request.headers["x-internal-key"] as string | undefined) ??
        (request.query as Record<string, string>)?.key;

      if (!matchesRotatableKey(internalKey, config.LARAVEL_INTERNAL_KEY, parsePreviousKeys(config.LARAVEL_INTERNAL_KEY_PREVIOUS))) {
        return reply
          .code(401)
          .send({ status: "error", message: "Unauthorized" });
      }

      // --- Parse Event ---
      let raw: unknown = request.body;

      // If body is a string (SNS raw message or text/plain), parse it
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return reply
            .code(400)
            .send({ status: "error", message: "Invalid JSON" });
        }
      }

      // SNS "Notification" envelope — delivered when the subscription does NOT
      // have Raw Message Delivery enabled (the SNS default). The actual event
      // JSON is a string in the `Message` field, not at the top level, so the
      // schema below would 422 every event. Unwrap it. Raw-delivery
      // subscriptions and direct Laravel POSTs have no envelope and skip this.
      if (
        raw !== null &&
        typeof raw === "object" &&
        (raw as Record<string, unknown>).Type === "Notification" &&
        typeof (raw as Record<string, unknown>).Message === "string"
      ) {
        try {
          raw = JSON.parse((raw as { Message: string }).Message);
        } catch {
          return reply
            .code(400)
            .send({ status: "error", message: "Invalid SNS Message JSON" });
        }
      }

      const result = EventPayloadSchema.safeParse(raw);
      if (!result.success) {
        fastify.log.warn(
          { errors: result.error.flatten().fieldErrors },
          "Invalid event payload",
        );
        return reply.code(422).send({
          status: "error",
          message: "Invalid event: schema validation failed",
          errors: result.error.flatten().fieldErrors,
        });
      }

      const event: LaravelEvent = result.data;

      // F-40: backpressure — shed load past the concurrency cap so a burst
      // can't saturate the event loop. SNS retries 503s with backoff.
      if (inFlightEvents >= MAX_CONCURRENT_EVENTS) {
        fastify.log.warn(
          { inFlight: inFlightEvents, event: event.event },
          "Event ingest at capacity — shedding (503)",
        );
        return reply.code(503).header("Retry-After", "1").send({
          status: "error",
          message: "Event ingest at capacity, retry",
        });
      }

      // --- GATE: at-least-once deduplication ---
      //
      // Deliberately placed AFTER the 503 shed above. Claiming the event first
      // would mark a shed event as seen, and Laravel's retry of that very event
      // would then be dropped at this gate — silent event loss precisely when
      // load is highest. With the shed ahead of it, no non-2xx reply exists
      // downstream of the claim.
      //
      // See event-dedup.ts for why the key is not `correlation_id` alone.
      const dedupKey = redis ? buildDedupKey(event) : null;
      if (redis && dedupKey && !(await claimEvent(redis, dedupKey))) {
        metrics.laravelEventsDeduplicated.inc({ event_type: event.event });
        fastify.log.info(
          {
            event: event.event,
            userId: event.user_id,
            roomId: event.room_id,
            correlationId: event.correlation_id,
          },
          "Event ingest: duplicate suppressed",
        );
        // 200, not 4xx: a non-2xx makes the sender retry the delivery we just
        // suppressed, turning one duplicate into a retry loop.
        return reply
          .code(200)
          .send({ status: "ok", duplicate: true, delivered: false, target_count: 0 });
      }

      fastify.log.info(
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
      // Adopt the API's identifier as the ambient one for the whole routing operation. This is the
      // join that makes a Laravel request and the socket delivery it caused appear as one trace:
      // every log line written beneath this point carries the sender's id without naming it.
      //
      // The schema defaults `correlation_id` to the literal "unknown" when absent, which
      // resolveCorrelationId treats as missing and replaces with a minted id — a real identifier
      // that joins nothing beats the string "unknown" repeated across unrelated events.
      inFlightEvents++;
      try {
        const routingResult = await withCorrelation(event.correlation_id, () =>
          eventRouter.route(event),
        );

        return reply.code(200).send({
          status: "ok",
          delivered: routingResult.delivered,
          target_count: routingResult.targetCount,
        });
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
    });
  };
};
