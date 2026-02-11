import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before imports
const mockVerifyJwt = vi.fn();
vi.mock("@src/auth/jwtValidator.js", () => ({
  verifyJwt: (...args: unknown[]) => mockVerifyJwt(...args),
}));

const mockGetRedisClient = vi.fn();
vi.mock("@src/infrastructure/redis.js", () => ({
  getRedisClient: () => mockGetRedisClient(),
}));

vi.mock("@src/config/index.js", () => ({
  config: {
    CORS_ORIGINS: new Set(["https://flyliveapp.com", "https://www.flyliveapp.com"]),
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

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    authAttempts: { inc: vi.fn() },
  },
}));

import { authMiddleware } from "@src/auth/middleware.js";
import { metrics } from "@src/infrastructure/metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function createMockSocket(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-socket-id",
    data: {},
    handshake: {
      auth: { token: overrides.token ?? "valid.jwt.token" },
      headers: {
        origin: overrides.origin ?? "https://flyliveapp.com",
        ...(overrides.authorizationHeader ? { authorization: overrides.authorizationHeader } : {}),
      },
    },
    ...overrides,
  };
}

const validUser = {
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
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe("authMiddleware", () => {
  let mockRedis: object;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {};
    mockGetRedisClient.mockReturnValue(mockRedis);
    mockVerifyJwt.mockResolvedValue(validUser);
  });

  it("rejects connection without token", async () => {
    const socket = createMockSocket({
      token: undefined,
      handshake: { auth: {}, headers: { origin: "https://flyliveapp.com" } },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Authentication required" }));
    expect(metrics.authAttempts.inc).toHaveBeenCalledWith({ result: "no_token" });
  });

  it("rejects connection with blocked origin", async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: "some.jwt.token" },
        headers: { origin: "https://evil-site.com" },
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Origin not allowed" }));
    expect(metrics.authAttempts.inc).toHaveBeenCalledWith({ result: "origin_blocked" });
  });

  it("allows connection without origin header (mobile clients)", async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: "some.jwt.token" },
        headers: {}, // No origin — mobile/native client
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(next).toHaveBeenCalledWith(); // No error
    expect(metrics.authAttempts.inc).toHaveBeenCalledWith({ result: "success" });
  });

  it("strips Bearer prefix from authorization header", async () => {
    const socket = createMockSocket({
      handshake: {
        auth: {},
        headers: {
          origin: "https://flyliveapp.com",
          authorization: "Bearer my.jwt.token",
        },
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    // verifyJwt should receive the clean token without "Bearer "
    expect(mockVerifyJwt).toHaveBeenCalledWith("my.jwt.token", mockRedis, expect.anything());
  });

  it("attaches user to socket.data on success", async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: "valid.jwt.token" },
        headers: { origin: "https://flyliveapp.com" },
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(socket.data).toEqual({ user: validUser });
    expect(next).toHaveBeenCalledWith(); // No error
  });

  it("does NOT store token in socket.data", async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: "valid.jwt.token" },
        headers: { origin: "https://flyliveapp.com" },
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(socket.data).not.toHaveProperty("token");
  });

  it("rejects when verifyJwt returns null", async () => {
    mockVerifyJwt.mockResolvedValue(null);

    const socket = createMockSocket({
      handshake: {
        auth: { token: "invalid.jwt.token" },
        headers: { origin: "https://flyliveapp.com" },
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Invalid credentials" }));
    expect(metrics.authAttempts.inc).toHaveBeenCalledWith({ result: "invalid_token" });
  });

  it("handles verifyJwt exception gracefully", async () => {
    mockVerifyJwt.mockRejectedValue(new Error("Unexpected error"));

    const socket = createMockSocket({
      handshake: {
        auth: { token: "valid.jwt.token" },
        headers: { origin: "https://flyliveapp.com" },
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Authentication failed" }));
    expect(metrics.authAttempts.inc).toHaveBeenCalledWith({ result: "error" });
  });
});
