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

  it("rejects connection without origin header (F-63: leaked-JWT curl/script reuse)", async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: "some.jwt.token" },
        headers: {}, // No origin — every legit client (TWA/PWA) is browser-backed and sends one
      },
    });
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authMiddleware(socket as any, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "Origin not allowed" }));
    expect(metrics.authAttempts.inc).toHaveBeenCalledWith({ result: "origin_blocked" });
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

    // ticket 10: socket.data now also carries a correlation id (handshake-supplied
    // or minted) alongside `user` — asserted precisely by the correlation-id tests
    // below, so here we only pin down `user` and that some id is present.
    expect(socket.data).toEqual({
      user: validUser,
      correlationId: expect.any(String),
    });
    expect(next).toHaveBeenCalledWith(); // No error
  });

  // ─── ticket 10: correlation id adopted at the handshake ──────────────────

  describe("correlation id (ticket 10)", () => {
    const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

    it("adopts a valid handshake-supplied correlation id onto socket.data", async () => {
      const socket = createMockSocket({
        handshake: {
          auth: { token: "valid.jwt.token", correlationId: "web-abc123.DEF:456" },
          headers: { origin: "https://flyliveapp.com" },
        },
      });
      const next = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await authMiddleware(socket as any, next);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((socket.data as any).correlationId).toBe("web-abc123.DEF:456");
      expect(next).toHaveBeenCalledWith();
    });

    it("mints an id when the handshake supplies none — no hard failure (AC#4)", async () => {
      const socket = createMockSocket({
        handshake: {
          auth: { token: "valid.jwt.token" }, // no correlationId key at all
          headers: { origin: "https://flyliveapp.com" },
        },
      });
      const next = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await authMiddleware(socket as any, next);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const correlationId = (socket.data as any).correlationId as string;
      expect(correlationId).toMatch(SAFE_ID_PATTERN);
      expect(next).toHaveBeenCalledWith(); // still connects
    });

    it("replaces a malformed (bad-charset) handshake id rather than adopting it", async () => {
      const socket = createMockSocket({
        handshake: {
          // '/' and '+' are outside the [A-Za-z0-9._:-] contract — e.g. base64.
          auth: { token: "valid.jwt.token", correlationId: "abc/def+ghi==" },
          headers: { origin: "https://flyliveapp.com" },
        },
      });
      const next = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await authMiddleware(socket as any, next);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const correlationId = (socket.data as any).correlationId as string;
      expect(correlationId).not.toBe("abc/def+ghi==");
      expect(correlationId).toMatch(SAFE_ID_PATTERN);
    });

    it("replaces a handshake id over 128 characters rather than adopting it", async () => {
      const tooLong = "a".repeat(129);
      const socket = createMockSocket({
        handshake: {
          auth: { token: "valid.jwt.token", correlationId: tooLong },
          headers: { origin: "https://flyliveapp.com" },
        },
      });
      const next = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await authMiddleware(socket as any, next);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const correlationId = (socket.data as any).correlationId as string;
      expect(correlationId).not.toBe(tooLong);
      expect(correlationId.length).toBeLessThanOrEqual(128);
    });

    it("logs the adopted correlation id on the 'Client authenticated' line", async () => {
      const socket = createMockSocket({
        handshake: {
          auth: { token: "valid.jwt.token", correlationId: "req-known-id-1" },
          headers: { origin: "https://flyliveapp.com" },
        },
      });
      const next = vi.fn();
      const { logger } = await import("@src/infrastructure/logger.js");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await authMiddleware(socket as any, next);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: "req-known-id-1" }),
        "Client authenticated",
      );
    });
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
