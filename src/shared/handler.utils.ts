/**
 * Socket handler utilities
 * Provides a createHandler wrapper for consistent validation, error handling, and metrics
 */
import { z } from "zod";
import type { Socket } from "socket.io";
import * as Sentry from "@sentry/node";
import { logger } from "@src/infrastructure/logger.js";
import { generateCorrelationId } from "./crypto.js";
import { Errors } from "./errors.js";
import type { AppContext } from "@src/context.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { seenRecently } from "@src/infrastructure/sentry/dedupe.js";

/**
 * F-3: record per-event throughput + latency for every wrapped handler.
 * Without this the entire flylive_socket_events_total /
 * flylive_socket_event_latency_seconds series are empty and any
 * dashboard/alert built on them silently never fires.
 */
function recordEvent(
  eventName: string,
  status: "ok" | "fail" | "error",
  startTime: number,
): void {
  metrics.eventsTotal.inc({ event: eventName, status });
  metrics.eventLatency.observe({ event: eventName }, (Date.now() - startTime) / 1000);
}

/**
 * Standard handler result shape
 */
export interface HandlerResult {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Handler function signature
 */
type HandlerFn<TPayload> = (
  payload: TPayload,
  socket: Socket,
  context: AppContext,
) => Promise<HandlerResult>;

/**
 * Callback function signature from Socket.IO
 */
type SocketCallback = (result: HandlerResult) => void;

/**
 * Create a wrapped socket event handler with:
 * - Zod schema validation
 * - Centralized error handling
 * - Logging with correlation IDs
 * - Metrics tracking (when metrics are available)
 *
 * @param eventName - The socket event name (for logging/metrics)
 * @param schema - Zod schema to validate the payload
 * @param handler - The actual handler function
 * @returns A function that takes (socket, context) and returns the event handler
 *
 * @example
 * ```typescript
 * export const takeSeatHandler = createHandler(
 *   'seat:take',
 *   seatTakeSchema,
 *   async (payload, socket, context) => {
 *     // Business logic here
 *     return { success: true };
 *   }
 * );
 *
 * // In junction file:
 * socket.on('seat:take', takeSeatHandler(socket, context));
 * ```
 */
export function createHandler<TPayload>(
  eventName: string,
  schema: z.ZodSchema<TPayload>,
  handler: HandlerFn<TPayload>,
) {
  return (socket: Socket, context: AppContext) => {
    return async (rawPayload: unknown, callback?: SocketCallback) => {
      const startTime = Date.now();
      const requestId = generateCorrelationId();
      const userId = socket.data.user?.id;

      // 1. Validate payload
      const parseResult = schema.safeParse(rawPayload);
      if (!parseResult.success) {
        logger.debug(
          {
            requestId,
            event: eventName,
            userId,
            errors: parseResult.error.format(),
          },
          "Validation failed",
        );
        recordEvent(eventName, "fail", startTime);

        // GATE failures are normally not errors, but a schema mismatch is a
        // deliberate exception: grouping collapses thousands of client-side
        // rejections into ONE Sentry issue named by the offending field, and
        // release-health flags it as new — surfacing a frontend/MSAB contract
        // break at a glance instead of drowning in per-request noise.
        const issue = parseResult.error.issues[0];
        const issuePath = issue?.path.join(".") ?? "unknown";
        // Deduped BEFORE capture, not by fingerprinting alone. Fingerprinting
        // collapses these into one ISSUE, but every event still spends a
        // token from the bucket in beforeSend — and GATE rejections are
        // client-driven and unbounded, so a single bad frontend build could
        // otherwise drain the burst budget and starve real crash reports.
        if (!seenRecently(`gate|${eventName}|${issuePath}`)) {
          Sentry.withScope((scope) => {
            if (userId !== undefined) scope.setUser({ id: String(userId) });
            scope.setTags({ stage: "gate", event: eventName });
            scope.setFingerprint(["invalid-payload", eventName, issuePath]);
            scope.setExtras({
              path: issuePath,
              code: issue?.code ?? "unknown",
              expected: (issue as { expected?: unknown } | undefined)?.expected ?? "unknown",
              // `received` is coerced to its TYPE on purpose: Zod carries the real value
              // for literal/enum mismatches, and that value must never leave the process.
              received: typeof (issue as { received?: unknown } | undefined)?.received,
            });
            Sentry.captureMessage("Payload rejected", "warning");
          });
        }

        callback?.({ success: false, error: Errors.INVALID_PAYLOAD });
        return;
      }

      // 2. Execute handler
      try {
        const result = await handler(parseResult.data, socket, context);

        const durationMs = Date.now() - startTime;
        recordEvent(eventName, result.success ? "ok" : "fail", startTime);
        logger.debug(
          {
            requestId,
            event: eventName,
            userId,
            success: result.success,
            durationMs,
          },
          "Handler completed",
        );

        callback?.(result);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        recordEvent(eventName, "error", startTime);
        logger.error(
          {
            err,
            requestId,
            event: eventName,
            userId,
            durationMs,
          },
          "Handler exception",
        );

        Sentry.withScope((scope) => {
          if (userId !== undefined) scope.setUser({ id: String(userId) });
          scope.setTags({ stage: "execute", event: eventName });
          scope.setExtras({ requestId, durationMs });
          scope.setContext("payload_shape", payloadShape(parseResult.data));
          Sentry.captureException(err);
        });

        callback?.({ success: false, error: Errors.INTERNAL_ERROR });
      }
    };
  };
}

/**
 * Create a handler without validation (for events with no payload)
 */
export function createSimpleHandler(
  eventName: string,
  handler: (socket: Socket, context: AppContext) => Promise<HandlerResult>,
) {
  return (socket: Socket, context: AppContext) => {
    return async (callback?: SocketCallback) => {
      const startTime = Date.now();
      const requestId = generateCorrelationId();
      const userId = socket.data.user?.id;

      try {
        const result = await handler(socket, context);

        const durationMs = Date.now() - startTime;
        recordEvent(eventName, result.success ? "ok" : "fail", startTime);
        logger.debug(
          {
            requestId,
            event: eventName,
            userId,
            success: result.success,
            durationMs,
          },
          "Handler completed",
        );

        callback?.(result);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        recordEvent(eventName, "error", startTime);
        logger.error(
          {
            err,
            requestId,
            event: eventName,
            userId,
            durationMs,
          },
          "Handler exception",
        );

        Sentry.withScope((scope) => {
          if (userId !== undefined) scope.setUser({ id: String(userId) });
          scope.setTags({ stage: "execute", event: eventName });
          scope.setExtras({ requestId, durationMs });
          Sentry.captureException(err);
        });

        callback?.({ success: false, error: Errors.INTERNAL_ERROR });
      }
    };
  };
}

/**
 * Shape, never content. Every payload is Zod-validated, so the shape is free
 * to derive — and a chat body, DM body or any other free-text field must
 * never leave the process. A per-event allowlist was rejected: it drifts, and
 * a newly added field would leak silently.
 */
function payloadShape(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    return { type: "array", length: payload.length };
  }

  if (payload !== null && typeof payload === "object") {
    const keys: Record<string, string> = {};
    for (const key of Object.keys(payload).slice(0, 50)) {
      keys[key] = typeof (payload as Record<string, unknown>)[key];
    }

    let byteLength: number | "unknown" = "unknown";
    try {
      byteLength = JSON.stringify(payload)?.length ?? "unknown";
    } catch {
      byteLength = "unknown";
    }

    return { keys, byteLength };
  }

  return { type: typeof payload };
}
