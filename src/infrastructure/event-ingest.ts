/**
 * Event Ingest Route
 * HTTP endpoint for receiving Laravel events via AWS SNS (or direct POST).
 *
 * Replaces Redis pub/sub for Laravel → MSAB event delivery.
 * Handles:
 *  - SNS SubscriptionConfirmation (auto-confirms the subscription)
 *  - SNS Notification with raw message delivery (event JSON)
 *  - Direct POST from Laravel (same JSON format)
 */
import type { FastifyPluginAsync } from "fastify";
import type { EventRouter } from "@src/integrations/laravel/event-router.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";
import { config } from "@src/config/index.js";
import { z } from "zod";

/** Zod schema — matches the existing LaravelEventSchema in event-subscriber.ts */
const EventPayloadSchema = z.object({
  event: z.string(),
  user_id: z.number().nullable().default(null),
  room_id: z.number().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
  timestamp: z.string().default(() => new Date().toISOString()),
  correlation_id: z.string().default("unknown"),
});

export const createEventIngestRoutes = (
  eventRouter: EventRouter,
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
     * 1. AWS SNS (with SubscriptionConfirmation handling)
     * 2. Direct HTTP POST from Laravel
     */
    fastify.post("/api/events", async (request, reply) => {
      // --- SNS Subscription Confirmation ---
      const snsMessageType = request.headers["x-amz-sns-message-type"];

      fastify.log.info(
        { snsMessageType: snsMessageType ?? "none", contentType: request.headers["content-type"] },
        "Event ingest: request received",
      );

      if (snsMessageType === "SubscriptionConfirmation") {
        const body = request.body as { SubscribeURL?: string };
        if (body.SubscribeURL) {
          // Auto-confirm SNS subscription
          try {
            await fetch(body.SubscribeURL);
            fastify.log.info("SNS subscription confirmed");
            return reply.code(200).send({ status: "ok", message: "Subscription confirmed" });
          } catch (err) {
            fastify.log.error({ err }, "Failed to confirm SNS subscription");
            return reply.code(500).send({ status: "error", message: "Confirmation failed" });
          }
        }
        return reply.code(400).send({ status: "error", message: "Missing SubscribeURL" });
      }

      // --- Authentication ---
      const internalKey = request.headers["x-internal-key"] as string | undefined;
      const isSnsNotification = snsMessageType === "Notification";

      if (isSnsNotification) {
        // AUDIT-009 FIX: Validate SNS TopicArn to prevent spoofed notifications.
        // AWS SNS always includes the TopicArn in the notification body.
        const body = request.body as Record<string, unknown>;
        const topicArn = body?.TopicArn as string | undefined;
        const expectedTopicArn = config.MSAB_SNS_TOPIC_ARN;

        if (expectedTopicArn && topicArn !== expectedTopicArn) {
          fastify.log.warn({ topicArn, expectedTopicArn }, "SNS notification with unexpected TopicArn — rejected");
          return reply.code(403).send({ status: "error", message: "Invalid SNS TopicArn" });
        }
      } else if (internalKey !== config.LARAVEL_INTERNAL_KEY) {
        return reply.code(401).send({ status: "error", message: "Unauthorized" });
      }

      // --- Parse Event ---
      let raw: unknown = request.body;

      // If body is a string (SNS raw message), parse it
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return reply.code(400).send({ status: "error", message: "Invalid JSON" });
        }
      }

      // SNS standard delivery wraps the actual message in a Message field.
      // Unwrap it so the schema validates the inner event, not the envelope.
      if (isSnsNotification && typeof (raw as Record<string, unknown>)?.Message === "string") {
        try {
          raw = JSON.parse((raw as Record<string, unknown>).Message as string);
        } catch {
          return reply.code(400).send({ status: "error", message: "Invalid SNS Message JSON" });
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

      fastify.log.info(
        { event: event.event, userId: event.user_id, roomId: event.room_id, correlationId: event.correlation_id },
        "Event ingest: routing event",
      );

      // --- Route Event ---
      const routingResult = await eventRouter.route(event);

      return reply.code(200).send({
        status: "ok",
        delivered: routingResult.delivered,
        target_count: routingResult.targetCount,
      });
    });
  };
};
