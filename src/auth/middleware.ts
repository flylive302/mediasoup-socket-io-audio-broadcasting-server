import type { Socket } from "socket.io";
import { logger } from "@src/infrastructure/logger.js";
import { getRedisClient } from "@src/infrastructure/redis.js";
import { config } from "@src/config/index.js";
import { verifyJwt } from "./jwtValidator.js";
import { overlayUserXp } from "@src/shared/user-xp.js";
import { metrics } from "@src/infrastructure/metrics.js";
import type { AuthSocketData } from "./types.js";
import { Errors } from "@src/shared/errors.js";
import { resolveCorrelationId } from "@src/infrastructure/correlation.js";

export async function authMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
) {
  // ── GATE: Validate origin ──────────────────────────────
  // F-63: require an allowlisted Origin header. Every legitimate client is
  // WebView-backed: the PWA/web in the browser (Origin: https://app.flyliveapp.com)
  // and the Capacitor native shell, whose Android WebView reports
  // Origin: https://localhost (iOS: capacitor://localhost) — all must be in
  // CORS_ORIGINS or the socket handshake is refused ("audio connection failure"
  // in the native app). MSAB has no native socket client and no server-to-server
  // socket.io caller (no socket.io-client dependency), so a missing Origin only
  // ever indicates curl/script reuse of a leaked JWT — reject it. (Origin is
  // browser-enforced but spoofable by a determined attacker; the primary control
  // remains JWT signature + revocation + the shortened token lifetime, F-56.)
  const origin = socket.handshake.headers.origin;
  if (!origin || !config.CORS_ORIGINS.has(origin)) {
    logger.warn({ socketId: socket.id, origin: origin ?? null }, "Origin not allowed");
    metrics.authAttempts.inc({ result: "origin_blocked" });
    return next(new Error(Errors.ORIGIN_NOT_ALLOWED));
  }

  // ── GATE: Extract token ────────────────────────────────
  const token =
    socket.handshake.auth.token || socket.handshake.headers["authorization"];

  if (!token) {
    logger.warn({ socketId: socket.id }, "Connection attempt without token");
    metrics.authAttempts.inc({ result: "no_token" });
    return next(new Error(Errors.AUTH_REQUIRED));
  }

  // Handle "Bearer " prefix if present in header
  const cleanToken = token.replace(/^Bearer\s+/i, "");

  // ── EXECUTE: Verify JWT ────────────────────────────────
  const redis = getRedisClient();

  try {
    const jwtUser = await verifyJwt(cleanToken, redis, logger);

    if (!jwtUser) {
      logger.warn(
        { socketId: socket.id, tokenLength: cleanToken.length },
        "Invalid token provided — verifyJwt returned null (check preceding warn logs for reason)",
      );
      metrics.authAttempts.inc({ result: "invalid_token" });
      return next(new Error(Errors.INVALID_CREDENTIALS));
    }

    // ticket 10: adopt the handshake-supplied correlation id (or mint one) so every
    // subsequent log line for this socket — starting with the two below — carries it.
    // resolveCorrelationId is the same validation `createHandler`/`createSimpleHandler`
    // already run against `socket.data.correlationId`; resolving here means the value
    // they read is always already-valid, never the raw untrusted handshake input.
    const rawCorrelationId = socket.handshake.auth.correlationId;
    const correlationId = resolveCorrelationId(
      typeof rawCorrelationId === "string" ? rawCorrelationId : undefined,
    );

    // JWT XP claims are a mint-time snapshot; overlay the latest persisted
    // XP so reconnects don't show stale (usually level-1) badges. Fail-open.
    const user = await overlayUserXp(redis, logger, jwtUser);

    // Attach user to socket (no token stored — AUTH-004)
    socket.data = { user, correlationId } as AuthSocketData;

    // Log only safe user properties
    logger.info(
      { socketId: socket.id, userId: user.id, userName: user.name, correlationId },
      "Client authenticated",
    );
    metrics.authAttempts.inc({ result: "success" });
    next();
  } catch (err) {
    logger.error({ err, socketId: socket.id }, "Authentication error");
    metrics.authAttempts.inc({ result: "error" });
    next(new Error(Errors.AUTH_FAILED));
  }
}
