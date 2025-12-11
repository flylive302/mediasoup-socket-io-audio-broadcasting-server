/**
 * Shared cryptographic utilities
 */
import { createHash } from "node:crypto";

/**
 * Create SHA-256 hash of a token for cache/revocation key generation
 * Used by auth middleware and SanctumValidator for consistent key generation
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
