import { pino } from "pino";
import { config, isDev } from "@src/config/index.js";

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
  ...(isDev && { transport: devTransport }),
});

export type Logger = typeof logger;
