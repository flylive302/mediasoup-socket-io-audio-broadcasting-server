import { pino, stdSerializers } from "pino";
import { config } from "@src/config/index.js";

const devTransport = {
  target: "pino-pretty",
  options: {
    translateTime: "HH:MM:ss Z",
    ignore: "pid,hostname",
    colorize: true,
  },
  // msab-sentry: this transport runs in a WORKER THREAD, and Node propagates
  // the entry's `--import ./src/instrument.ts` into workers via execArgv. The
  // worker has no tsx loader, so instrument.ts's `./config/index.js` specifier
  // fails to resolve (ERR_MODULE_NOT_FOUND) — the logging worker dies and dev
  // boot stalls with ZERO log output. Empty execArgv keeps the preload on the
  // main thread only (which is the only place Sentry must be initialised).
  // Production is unaffected: no transport is configured there (see below).
  worker: { execArgv: [] },
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
