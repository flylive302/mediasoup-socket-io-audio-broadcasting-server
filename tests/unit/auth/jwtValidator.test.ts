import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";

// Mock config before importing modules that use it
vi.mock("@src/config/index.js", () => ({
  config: {
    JWT_SECRET: "test-secret-key-that-is-at-least-32-chars",
    JWT_MAX_AGE_SECONDS: 86_400,
  },
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockAuthAttempts } = vi.hoisted(() => ({
  mockAuthAttempts: { inc: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    authAttempts: mockAuthAttempts,
  },
}));

import { verifyJwt } from "@src/auth/jwtValidator.js";
import { config } from "@src/config/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const SECRET = "test-secret-key-that-is-at-least-32-chars";

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createJwt(
  payload: Record<string, unknown>,
  secret: string = SECRET,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${base64UrlEncode(signature)}`;
}

function validUserPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: "Test User",
    signature: "1234567",
    email: "test@example.com",
    avatar: "https://example.com/avatar.jpg",
    frame: "gold",
    gender: 1,
    date_of_birth: "1990-01-01",
    phone: "+1234567890",
    country: "US",
    coins: "1000",
    diamonds: "500",
    wealth_xp: "2500",
    charm_xp: "1200",
    is_blocked: false,
    isSpeaker: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockRedis: any;

/**
 * Build a chainable pipeline mock that resolves exec() with the given results.
 * Production calls: redis.pipeline().get(userKey); pipeline.exists(tokenKey); pipeline.exec()
 * Each result tuple is [error, value] matching ioredis pipeline.exec() shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createPipelineMock(execResults: Array<[Error | null, unknown]>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipeline: any = {};
  pipeline.get = vi.fn().mockReturnValue(pipeline);
  pipeline.exists = vi.fn().mockReturnValue(pipeline);
  pipeline.exec = vi.fn().mockResolvedValue(execResults);
  return pipeline;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("JwtValidator", () => {
  beforeEach(() => {
    mockRedis = {
      exists: vi.fn().mockResolvedValue(0),
      // Default: neither user-level nor token-hash revocation set
      pipeline: vi.fn().mockReturnValue(
        createPipelineMock([
          [null, null], // userRevoked GET → no revocation timestamp
          [null, 0],    // tokenRevoked EXISTS → not revoked
        ]),
      ),
    };
  });

  it("returns user for a valid JWT", async () => {
    const payload = validUserPayload();
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    expect(user).not.toBeNull();
    expect(user!.id).toBe(42);
    expect(user!.name).toBe("Test User");
    expect(user!.email).toBe("test@example.com");
  });

  it("returns null for expired JWT", async () => {
    const payload = validUserPayload({
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    expect(user).toBeNull();
  });

  it("returns null for invalid signature (tampered token)", async () => {
    const payload = validUserPayload();
    const token = createJwt(payload, "wrong-secret-key-that-is-at-least-32-ch");

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    expect(user).toBeNull();
  });

  it("returns null for malformed JWT (not 3 parts)", async () => {
    const user = await verifyJwt("not.a.valid.jwt.token", mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);
    expect(user).toBeNull();

    const user2 = await verifyJwt("only-one-part", mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);
    expect(user2).toBeNull();
  });

  it("fills defaults for missing optional fields in JWT payload", async () => {
    const payload = { id: 42, name: "Test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    // Schema now uses .default() for optional fields — missing fields get defaults
    expect(user).not.toBeNull();
    expect(user!.id).toBe(42);
    expect(user!.name).toBe("Test");
    expect(user!.email).toBe("");
    expect(user!.avatar).toBe("");
    expect(user!.vip_level).toBe(0);
    expect(user!.isSpeaker).toBe(false);
  });

  it("gift-authority-tick-fanout 09: an older token without level/is_vip claims still verifies, defaulting to level 0 / not VIP", async () => {
    const payload = validUserPayload();
    delete payload.level;
    delete payload.is_vip;
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    expect(user).not.toBeNull();
    expect(user!.level).toBe(0);
    expect(user!.is_vip).toBe(false);
  });

  it("gift-authority-tick-fanout 09: a token WITH level/is_vip claims passes them through", async () => {
    const token = createJwt(validUserPayload({ level: 12, is_vip: true }));

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    expect(user).not.toBeNull();
    expect(user!.level).toBe(12);
    expect(user!.is_vip).toBe(true);
  });

  it("returns null for revoked token", async () => {
    // Token-hash revocation is set — second pipeline result returns EXISTS=1
    mockRedis.pipeline.mockReturnValue(
      createPipelineMock([
        [null, null], // userRevoked GET → not revoked
        [null, 1],    // tokenRevoked EXISTS → revoked
      ]),
    );

    const payload = validUserPayload();
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    expect(user).toBeNull();
    expect(mockRedis.pipeline).toHaveBeenCalled();
  });

  it("returns user (fail-open) on Redis error during revocation check", async () => {
    // Pipeline exec throws — simulates Redis unreachable during revocation check
    const pipeline = createPipelineMock([]);
    pipeline.exec.mockRejectedValue(new Error("Redis connection lost"));
    mockRedis.pipeline.mockReturnValue(pipeline);

    const payload = validUserPayload();
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

    // Fail-open: user with valid HMAC-signed JWT is allowed through
    // even when Redis is unreachable for revocation check
    expect(user).not.toBeNull();
    expect(user!.id).toBe(42);
    expect(mockAuthAttempts.inc).toHaveBeenCalledWith({ result: "redis_error" });
  });

  // platform-security 06: configurable fail-policy. The mocked config above
  // has no JWT_REVOCATION_FAIL_OPEN field at all — the test above already
  // pins that an undefined config value still resolves to fail-open (today's
  // hardcoded behavior). These pin the explicit-true and explicit-false
  // settings, mutating the mocked config object directly (same technique as
  // rateLimiter.test.ts) and restoring it afterwards.
  describe("JWT_REVOCATION_FAIL_OPEN", () => {
    afterEach(() => {
      delete (config as { JWT_REVOCATION_FAIL_OPEN?: boolean })
        .JWT_REVOCATION_FAIL_OPEN;
    });

    it("returns user (fail-open) on Redis error when explicitly true", async () => {
      (config as { JWT_REVOCATION_FAIL_OPEN?: boolean }).JWT_REVOCATION_FAIL_OPEN = true;

      const pipeline = createPipelineMock([]);
      pipeline.exec.mockRejectedValue(new Error("Redis connection lost"));
      mockRedis.pipeline.mockReturnValue(pipeline);

      const payload = validUserPayload();
      const token = createJwt(payload);

      const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

      expect(user).not.toBeNull();
      expect(user!.id).toBe(42);
      expect(mockAuthAttempts.inc).toHaveBeenCalledWith({ result: "redis_error" });
    });

    it("returns null (fail-closed) on Redis error when explicitly false", async () => {
      (config as { JWT_REVOCATION_FAIL_OPEN?: boolean }).JWT_REVOCATION_FAIL_OPEN = false;

      const pipeline = createPipelineMock([]);
      pipeline.exec.mockRejectedValue(new Error("Redis connection lost"));
      mockRedis.pipeline.mockReturnValue(pipeline);

      const payload = validUserPayload();
      const token = createJwt(payload);

      const user = await verifyJwt(token, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);

      // Still an existing user with a valid HMAC signature, but the
      // configured fail-policy now rejects on the Redis error.
      expect(user).toBeNull();
      // The log + metric must still fire under fail-closed too.
      expect(mockAuthAttempts.inc).toHaveBeenCalledWith({ result: "redis_error" });
    });
  });

  it("uses iat + max age fallback when no exp claim", async () => {
    // iat is recent, no exp — should be valid
    const recentPayload = validUserPayload({
      iat: Math.floor(Date.now() / 1000) - 60,
    });
    delete recentPayload.exp;
    const validToken = createJwt(recentPayload);

    const user = await verifyJwt(validToken, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);
    expect(user).not.toBeNull();

    // iat is very old, no exp — should fail
    const oldPayload = validUserPayload({
      iat: Math.floor(Date.now() / 1000) - 200_000,
    });
    delete oldPayload.exp;
    const expiredToken = createJwt(oldPayload);

    const user2 = await verifyJwt(expiredToken, mockRedis as Redis, (await import("@src/infrastructure/logger.js")).logger);
    expect(user2).toBeNull();
  });

  // open-loops §15 — the payload-validation failure log is an ALLOWLIST. These
  // tests exist so that a claim added to the JWT later cannot start being logged
  // by accident; adding one must fail here before it reaches production logs.
  describe("payload-validation failure logging", () => {
    async function warnPayloadOfFailedValidation(
      payloadOverrides: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const { logger } = await import("@src/infrastructure/logger.js");
      vi.mocked(logger.warn).mockClear();

      // `name` must be a string — a number makes UserSchema.safeParse fail.
      const payload = validUserPayload({ name: 12345, ...payloadOverrides });
      const user = await verifyJwt(createJwt(payload), mockRedis as Redis, logger);
      expect(user).toBeNull();

      const call = vi
        .mocked(logger.warn)
        .mock.calls.find((c) =>
          String(c[1] ?? "").includes("Payload validation failed"),
        );
      expect(call, "expected a payload-validation-failed warn log").toBeDefined();
      return call![0] as Record<string, unknown>;
    }

    it("logs values for allowlisted claims only", async () => {
      const logged = await warnPayloadOfFailedValidation({});
      const values = logged.payloadValues as Record<string, unknown>;

      expect(Object.keys(values).sort()).toEqual(["exp", "iat", "id"]);
      expect(values.id).toBe(42);
    });

    it("does not log the value of any non-allowlisted claim", async () => {
      const logged = await warnPayloadOfFailedValidation({
        // A claim nobody has opted in — stands in for a future JWT addition.
        secret_new_claim: "leaked-value",
      });

      const serialized = JSON.stringify(logged);
      expect(serialized).not.toContain("leaked-value");
      expect(serialized).not.toContain("test@example.com"); // email
      expect(serialized).not.toContain("+1234567890"); // phone
      expect(serialized).not.toContain("Test User"); // name (the failing field)
    });

    it("still reports the type of every claim, so schema mismatches stay diagnosable", async () => {
      const logged = await warnPayloadOfFailedValidation({
        secret_new_claim: "leaked-value",
      });
      const types = logged.payloadTypes as Record<string, string>;

      expect(types.name).toBe("number"); // the actual mismatch, by type
      expect(types.email).toBe("string");
      expect(types.secret_new_claim).toBe("string");
      expect(types.is_blocked).toBe("boolean");
    });

    it("reports null and array claims distinctly rather than as 'object'", async () => {
      const logged = await warnPayloadOfFailedValidation({
        avatar: null,
        equipped_badges: [],
      });
      const types = logged.payloadTypes as Record<string, string>;

      expect(types.avatar).toBe("null");
      expect(types.equipped_badges).toBe("array");
    });
  });
});
