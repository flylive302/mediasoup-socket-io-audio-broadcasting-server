/**
 * Correlation ID generation for request tracing
 */
import { randomBytes } from "node:crypto";

/**
 * Generate a unique correlation/request ID for tracing requests across logs
 * Used to correlate logs between this server and Laravel backend
 */
export function generateCorrelationId(): string {
  return randomBytes(8).toString("hex");
}
