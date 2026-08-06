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
import { parsePreviousKeys } from "@src/shared/keyRotation.js";
import { metrics } from "@src/infrastructure/metrics.js";

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
export async function verifyJwt(
  token: string,
  redis: Redis,
  logger: Logger,
): Promise<User | null> {
  // 1. Split JWT into parts
  const parts = token.split(".");
  if (parts.length !== 3) {
    logger.warn(
      // No token prefix: a string that failed the 3-part split is not necessarily
      // a JWT header — a Sanctum token sent here by mistake would put live
      // credential material in the logs. partsCount + length identify the shape.
      { partsCount: parts.length, tokenLength: token.length },
      "JWT: Invalid format (expected 3 parts)",
    );
    return null;
  }

  // Length check above guarantees all 3 parts exist
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const signatureB64 = parts[2]!;

  // 2. Verify signature (HMAC-SHA256, timing-safe)
  //
  // Tries the current secret first, then any rotation-overlap secrets from
  // JWT_SECRET_PREVIOUS. During a rotation Laravel keeps minting with the old
  // secret until its console edit lands, while this fleet may already be
  // running the new one — without the overlap every such token is rejected and
  // the user is thrown off audio. The list is empty outside a rotation.
  try {
    const signingInput = `${headerB64}.${payloadB64}`;
    const receivedSignature = base64UrlDecode(signatureB64);

    const candidateSecrets = [
      config.JWT_SECRET,
      ...parsePreviousKeys(config.JWT_SECRET_PREVIOUS),
    ];

    // Not short-circuited: every candidate is checked so verification time
    // does not reveal which secret matched.
    let signatureValid = false;
    for (const secret of candidateSecrets) {
      const expectedSignature = createHmac("sha256", secret)
        .update(signingInput)
        .digest();

      if (
        expectedSignature.length === receivedSignature.length &&
        timingSafeEqual(expectedSignature, receivedSignature)
      ) {
        signatureValid = true;
      }
    }

    if (!signatureValid) {
      logger.warn(
        {
          payloadHead: payloadB64.slice(0, 12),
          receivedLen: receivedSignature.length,
          candidatesTried: candidateSecrets.length,
        },
        "JWT: Signature verification failed",
      );
      return null;
    }
  } catch (err) {
    logger.warn({ err }, "JWT: Signature verification error");
    return null;
  }

  // 3. Decode payload
  let payload: Record<string, unknown>;
  try {
    const decoded = base64UrlDecode(payloadB64).toString("utf-8");
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "JWT: Failed to decode payload");
    return null;
  }

  // 4. Check expiry
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === "number" && payload.exp < now) {
    logger.warn(
      { exp: payload.exp, now, delta: now - payload.exp, userId: payload.id },
      "JWT: Token expired",
    );
    return null;
  }

  // Fallback: if no exp claim, check iat + max age
  if (
    typeof payload.exp !== "number" &&
    typeof payload.iat === "number" &&
    payload.iat + config.JWT_MAX_AGE_SECONDS < now
  ) {
    logger.warn(
      {
        iat: payload.iat,
        maxAge: config.JWT_MAX_AGE_SECONDS,
        now,
        userId: payload.id,
      },
      "JWT: Token exceeds max age (no exp claim)",
    );
    return null;
  }

  // 5. Validate user payload via Zod
  const parseResult = UserSchema.safeParse(payload);
  if (!parseResult.success) {
    // Diagnose new-user JWT rejections without logging claim values. Types are
    // reported for every claim (that is what a schema mismatch needs); values
    // only for the allowlist below.
    const formattedErrors = parseResult.error.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
      received: i.code === "invalid_type" ? (i as { received?: string }).received : undefined,
    }));
    logger.warn(
      {
        errors: formattedErrors,
        payloadTypes: describeClaimTypes(payload),
        payloadValues: pickLoggableClaims(payload),
        userId: payload.id,
      },
      "JWT: Payload validation failed — check field types against UserSchema",
    );
    return null;
  }

  const user = parseResult.data;

  // 6. Check revocation (fail-policy configurable, default fail-OPEN — see
  // config.JWT_REVOCATION_FAIL_OPEN below)
  // HMAC signature verification above is the primary auth gate.
  // Revocation is defense-in-depth — by default we accept the risk of
  // allowing a recently-revoked token during a Redis blip rather than
  // blocking ALL users; JWT_REVOCATION_FAIL_OPEN=false flips that trade-off.
  //
  // platform-security 06 — residual risk, do NOT "fix" here (separate
  // decision): this check runs ONLY at socket CONNECT time, as connection
  // middleware (see src/auth/middleware.ts), with NO periodic revalidation
  // for the life of the connection. So even on the fail-CLOSED setting, a
  // token that already passed this check before a revocation landed stays
  // valid until the socket disconnects — potentially hours, not milliseconds.
  // And on a Redis blip under the default fail-OPEN setting, a token revoked
  // DURING the blip slips through this check entirely and is then subject to
  // that same no-revalidation window. The `auth:user_revoked:*` force-relay
  // from Laravel (event-router → targeted socket disconnect) is a separate
  // mitigation for the "already connected, later revoked" case, with its own
  // independent failure characteristics — it does not change anything about
  // this function's fail-policy.
  try {
    // Pipeline both revocation lookups in a single Redis round-trip
    const userRevokedKey = `auth:user_revoked:${user.id}`;
    const tokenRevokedKey = `auth:revoked:${hashToken(token)}`;
    const pipeline = redis.pipeline();
    pipeline.get(userRevokedKey);
    pipeline.exists(tokenRevokedKey);
    const results = await pipeline.exec();

    // User-level revocation (primary — set by Laravel via relay event)
    // Any JWT issued before the revocation timestamp is rejected.
    if (results?.[0]) {
      const [err, revokedAt] = results[0] as [Error | null, string | null];
      if (
        !err &&
        revokedAt !== null &&
        typeof payload.iat === "number" &&
        payload.iat < Number(revokedAt)
      ) {
        logger.warn(
          { userId: user.id },
          "JWT: Rejected — issued before user-level revocation",
        );
        return null;
      }
    }

    // Token-hash revocation (backward compat — kept for direct token invalidation)
    if (results?.[1]) {
      const [err, isRevoked] = results[1] as [Error | null, number];
      if (!err && isRevoked) {
        logger.warn(
          { userId: user.id },
          "JWT: Attempted use of revoked token (hash)",
        );
        return null;
      }
    }
  } catch (err) {
    // `!== false` (not a plain boolean read) so an omitted/undefined config
    // value — e.g. a test double that doesn't set this field — still resolves
    // to the safe fail-open default rather than silently flipping fail-closed.
    const failOpen = config.JWT_REVOCATION_FAIL_OPEN !== false;
    logger.warn(
      { err, userId: user.id, failOpen },
      "JWT: Redis unreachable during revocation check — applying configured fail-policy",
    );
    metrics.authAttempts.inc({ result: "redis_error" });

    if (!failOpen) {
      return null;
    }
    // Continue — user has a valid HMAC-signed JWT, allow connection (fail-open)
  }

  return user;
}

/**
 * Claims whose VALUES may be written to logs on a payload-validation failure.
 *
 * This is an allowlist on purpose (open-loops §15). It replaced a denylist that
 * stripped `email`/`phone` and logged everything else — under which any claim
 * Laravel adds to the JWT later would start being logged silently, by default.
 * Now a new claim is private until it is opted in here.
 */
const LOGGABLE_CLAIMS = ["id", "sub", "iat", "exp"] as const;

function pickLoggableClaims(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const claim of LOGGABLE_CLAIMS) {
    if (claim in payload) {
      picked[claim] = payload[claim];
    }
  }
  return picked;
}

/**
 * Type-only view of every claim. A UserSchema mismatch is a shape problem, so
 * the type is the diagnostic — the value is not needed and may be personal data.
 */
function describeClaimTypes(
  payload: Record<string, unknown>,
): Record<string, string> {
  const types: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    types[key] =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  }
  return types;
}
