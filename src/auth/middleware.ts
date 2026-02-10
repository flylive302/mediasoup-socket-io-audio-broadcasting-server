import type { Socket } from "socket.io";
import { logger } from "../infrastructure/logger.js";
import { getRedisClient } from "../infrastructure/redis.js";
import { config } from "../config/index.js";
import { verifyJwt } from "./jwtValidator.js";
import { metrics } from "../infrastructure/metrics.js";
import type { AuthSocketData } from "./types.js";
import { Errors } from "../shared/errors.js";

export async function authMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
) {
  // Validate WebSocket origin against CORS origins.
  // Connections without an Origin header are allowed intentionally —
  // native mobile apps and server-to-server clients do not send Origin.
  const origin = socket.handshake.headers.origin;
  if (origin && !config.CORS_ORIGINS.has(origin)) {
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

  try {
    const user = await verifyJwt(cleanToken, redis, logger);

    if (!user) {
      logger.warn({ socketId: socket.id }, "Invalid token provided");
      metrics.authAttempts.inc({ result: "invalid_token" });
      return next(new Error(Errors.INVALID_CREDENTIALS));
    }

    // Attach user to socket (no token stored — AUTH-004)
    socket.data = { user } as AuthSocketData;

    // Log only safe user properties
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
