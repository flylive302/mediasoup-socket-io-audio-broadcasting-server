/**
 * JWT Validator — Local HMAC-SHA256 signature verification
 * Replaces the HTTP-based SanctumValidator for zero-latency auth
 *
 * Flow:
 *   1. Decode JWT (header.payload.signature)
 *   2. Verify HMAC-SHA256 signature with shared secret
 *   3. Check expiry (exp claim)
 *   4. Parse payload through Zod UserSchema
 *   5. Optional: Check Redis revocation list
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { config } from "@src/config/index.js";
import { UserSchema } from "./types.js";
import type { User } from "./types.js";
import type { Logger } from "@src/infrastructure/logger.js";
import { hashToken } from "@src/shared/crypto.js";

/**
 * Base64URL decode (RFC 7515)
 */
function base64UrlDecode(input: string): Buffer {
  // Replace URL-safe chars and add padding
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Verify a JWT and extract the user payload.
 * Uses HMAC-SHA256 with timing-safe comparison to prevent timing attacks.
 *
 * @returns The validated User or null if verification fails
 */
export function verifyJwt(
  token: string,
  redis: Redis,
  logger: Logger,
): Promise<User | null> {
  return verifyJwtInternal(token, redis, logger);
}

async function verifyJwtInternal(
  token: string,
  redis: Redis,
  logger: Logger,
): Promise<User | null> {
  // 1. Split JWT into parts
  const parts = token.split(".");
  if (parts.length !== 3) {
    logger.debug("JWT: Invalid format (expected 3 parts)");
    return null;
  }

  // Length check above guarantees all 3 parts exist
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const signatureB64 = parts[2]!;

  // 2. Verify signature (HMAC-SHA256, timing-safe)
  try {
    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSignature = createHmac("sha256", config.JWT_SECRET)
      .update(signingInput)
      .digest();

    const receivedSignature = base64UrlDecode(signatureB64);

    if (
      expectedSignature.length !== receivedSignature.length ||
      !timingSafeEqual(expectedSignature, receivedSignature)
    ) {
      logger.debug("JWT: Signature verification failed");
      return null;
    }
  } catch {
    logger.debug("JWT: Signature verification error");
    return null;
  }

  // 3. Decode payload
  let payload: Record<string, unknown>;
  try {
    const decoded = base64UrlDecode(payloadB64).toString("utf-8");
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    logger.debug("JWT: Failed to decode payload");
    return null;
  }

  // 4. Check expiry
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === "number" && payload.exp < now) {
    logger.debug("JWT: Token expired");
    return null;
  }

  // Fallback: if no exp claim, check iat + max age
  if (
    typeof payload.exp !== "number" &&
    typeof payload.iat === "number" &&
    payload.iat + config.JWT_MAX_AGE_SECONDS < now
  ) {
    logger.debug("JWT: Token exceeds max age (no exp claim)");
    return null;
  }

  // 5. Validate user payload via Zod
  const parseResult = UserSchema.safeParse(payload);
  if (!parseResult.success) {
    logger.debug(
      { errors: parseResult.error.format() },
      "JWT: Payload validation failed",
    );
    return null;
  }

  const user = parseResult.data;

  // 6. Check revocation (fail-closed on Redis error)
  try {
    const revokedKey = `auth:revoked:${hashToken(token)}`;
    const isRevoked = await redis.exists(revokedKey);
    if (isRevoked) {
      logger.warn({ userId: user.id }, "JWT: Attempted use of revoked token");
      return null;
    }
  } catch (err) {
    logger.error({ err }, "JWT: Redis error during revocation check");
    // Fail closed for security
    return null;
  }

  return user;
}
