import { pino, stdSerializers } from "pino";
import { config } from "@src/config/index.js";

const devTransport = {
  target: "pino-pretty",
  options: {
    translateTime: "HH:MM:ss Z",
    ignore: "pid,hostname",
    colorize: true,
  },
};

export const logger = pino({
  level: config.LOG_LEVEL,
  // Pino only special-cases the `err` key by default, so `logger.error({ error })`
  // serializes an Error to `{}` and swallows the cause. Map `error` too so BOTH
  // conventions produce a full stack (this cost hours on the 2026-07-06 pipe bug).
  serializers: {
    err: stdSerializers.err,
    error: stdSerializers.err,
  },
  ...(config.NODE_ENV === "development" && { transport: devTransport }),
});

export type Logger = typeof logger;
