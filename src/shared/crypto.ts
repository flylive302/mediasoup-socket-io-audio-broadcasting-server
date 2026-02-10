/**
 * Shared cryptographic utilities
 * Consolidates correlation ID generation and token hashing
 */
import { randomBytes, createHash } from "node:crypto";

/**
 * Generate a unique correlation/request ID for tracing requests across logs
 * Used to correlate logs between this server and Laravel backend
 */
export function generateCorrelationId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Create SHA-256 hash of a token for cache/revocation key generation
 * Used by auth middleware and JwtValidator for consistent key generation
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
