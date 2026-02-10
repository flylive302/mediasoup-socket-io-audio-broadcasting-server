import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";

// Mock config before importing modules that use it
vi.mock("../config/index.js", () => ({
  config: {
    JWT_SECRET: "test-secret-key-that-is-at-least-32-chars",
    JWT_MAX_AGE_SECONDS: 86_400,
  },
}));

vi.mock("../infrastructure/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { verifyJwt } from "./jwtValidator.js";

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
    gender: "male",
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe("JwtValidator", () => {
  beforeEach(() => {
    mockRedis = {
      exists: vi.fn().mockResolvedValue(0),
    };
  });

  it("returns user for a valid JWT", async () => {
    const payload = validUserPayload();
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);

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

    const user = await verifyJwt(token, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);

    expect(user).toBeNull();
  });

  it("returns null for invalid signature (tampered token)", async () => {
    const payload = validUserPayload();
    const token = createJwt(payload, "wrong-secret-key-that-is-at-least-32-ch");

    const user = await verifyJwt(token, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);

    expect(user).toBeNull();
  });

  it("returns null for malformed JWT (not 3 parts)", async () => {
    const user = await verifyJwt("not.a.valid.jwt.token", mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);
    expect(user).toBeNull();

    const user2 = await verifyJwt("only-one-part", mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);
    expect(user2).toBeNull();
  });

  it("returns null when payload fails Zod validation (missing fields)", async () => {
    const payload = { id: 42, name: "Test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);

    expect(user).toBeNull();
  });

  it("returns null for revoked token", async () => {
    mockRedis.exists.mockResolvedValue(1); // Token is revoked

    const payload = validUserPayload();
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);

    expect(user).toBeNull();
    expect(mockRedis.exists).toHaveBeenCalled();
  });

  it("returns null (fail-closed) on Redis error during revocation check", async () => {
    mockRedis.exists.mockRejectedValue(new Error("Redis connection lost"));

    const payload = validUserPayload();
    const token = createJwt(payload);

    const user = await verifyJwt(token, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);

    expect(user).toBeNull();
  });

  it("uses iat + max age fallback when no exp claim", async () => {
    // iat is recent, no exp — should be valid
    const recentPayload = validUserPayload({
      iat: Math.floor(Date.now() / 1000) - 60,
    });
    delete recentPayload.exp;
    const validToken = createJwt(recentPayload);

    const user = await verifyJwt(validToken, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);
    expect(user).not.toBeNull();

    // iat is very old, no exp — should fail
    const oldPayload = validUserPayload({
      iat: Math.floor(Date.now() / 1000) - 200_000,
    });
    delete oldPayload.exp;
    const expiredToken = createJwt(oldPayload);

    const user2 = await verifyJwt(expiredToken, mockRedis as Redis, (await import("../infrastructure/logger.js")).logger);
    expect(user2).toBeNull();
  });
});
