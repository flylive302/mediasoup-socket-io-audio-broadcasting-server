/**
 * Socket handler utilities
 * Provides a createHandler wrapper for consistent validation, error handling, and metrics
 */
import { z } from "zod";
import type { Socket } from "socket.io";
import { logger } from "../infrastructure/logger.js";
import { generateCorrelationId } from "./correlation.js";
import type { AppContext } from "../context.js";

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
        callback?.({ success: false, error: "Invalid payload" });
        return;
      }

      // 2. Execute handler
      try {
        const result = await handler(parseResult.data, socket, context);

        const durationMs = Date.now() - startTime;
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

        callback?.({ success: false, error: "Internal server error" });
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

        callback?.({ success: false, error: "Internal server error" });
      }
    };
  };
}
