import type { Socket } from "socket.io";
import { logger } from "../infrastructure/logger.js";
import { getRedisClient } from "../infrastructure/redis.js";
import { config } from "../config/index.js";
import { SanctumValidator } from "./sanctumValidator.js";
import { metrics } from "../infrastructure/metrics.js";
import type { AuthSocketData } from "./types.js";
import { Errors } from "../shared/errors.js";

export async function authMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
) {
  // Validate WebSocket origin against CORS origins
  const origin = socket.handshake.headers.origin;
  if (origin && !config.CORS_ORIGINS.includes(origin)) {
    logger.warn({ socketId: socket.id, origin }, "Origin not allowed");
    metrics.authAttempts.inc({ result: "origin_blocked" });
    return next(new Error(Errors.ORIGIN_NOT_ALLOWED));
  }

  const token =
    socket.handshake.auth.token || socket.handshake.headers["authorization"];

  if (!token) {
    logger.warn({ socketId: socket.id }, "Connection attempt without token");
    metrics.authAttempts.inc({ result: "no_token" });
    return next(new Error(Errors.AUTH_REQUIRED));
  }

  // Handle "Bearer " prefix if present in header
  const cleanToken = token.replace(/^Bearer\s+/i, "");

  const redis = getRedisClient();

  // Note: Revocation check is handled inside SanctumValidator.validate()
  // No need to check here - avoids duplicate Redis round-trip

  const validator = new SanctumValidator(redis, logger);

  try {
    const user = await validator.validate(cleanToken);

    if (!user) {
      logger.warn({ socketId: socket.id }, "Invalid token provided");
      metrics.authAttempts.inc({ result: "invalid_token" });
      return next(new Error(Errors.INVALID_CREDENTIALS));
    }

    // Attach user to socket
    socket.data = {
      user,
      token: cleanToken,
    } as AuthSocketData;

    // Log only safe user properties (NOT the full user object which may contain token)
    logger.info(
      { socketId: socket.id, userId: user.id, userName: user.name },
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
