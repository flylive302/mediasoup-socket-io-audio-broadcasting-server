/**
 * Centralized configuration with runtime validation
 * All environment variables validated at startup via Zod
 */
import { z } from "zod";
import "dotenv/config";

const configSchema = z.object({
  // Server
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3030),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // SSL (required in production)
  SSL_KEY_PATH: z.string().optional(),
  SSL_CERT_PATH: z.string().optional(),

  // Redis
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_USERNAME: z.string().optional(), // Digital Ocean ACL username (usually 'default')
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(3), // Separate DB from Laravel
  REDIS_TLS: z
    .enum(["true", "false", "1", "0", ""])
    .default("")
    .transform((v) => v === "true" || v === "1"),

  // Laravel Integration
  LARAVEL_API_URL: z.string().url(),
  LARAVEL_INTERNAL_KEY: z.string().min(32), // For server-to-server auth

  // MediaSoup
  MEDIASOUP_LISTEN_IP: z.string().default("0.0.0.0"),
  MEDIASOUP_ANNOUNCED_IP: z.string().optional(), // Public IP for production
  MEDIASOUP_RTC_MIN_PORT: z.coerce.number().default(10000),
  MEDIASOUP_RTC_MAX_PORT: z.coerce.number().default(59999),

  // Limits
  MAX_ROOMS_PER_WORKER: z.coerce.number().default(100),
  MAX_CLIENTS_PER_ROOM: z.coerce.number().default(50),
  RATE_LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().default(60),

  // Mediasoup Workers
  MEDIASOUP_NUM_WORKERS: z.coerce.number().optional(), // If not set, uses os.cpus().length

  // Room Auto-Close (inactivity timer)
  ROOM_INACTIVITY_TIMEOUT_MS: z.coerce.number().default(30_000), // 30 seconds
  ROOM_AUTO_CLOSE_POLL_INTERVAL_MS: z.coerce.number().default(30_000), // 30 seconds

  // Gift Buffer
  GIFT_BUFFER_FLUSH_INTERVAL_MS: z.coerce.number().default(500),
  GIFT_MAX_RETRIES: z.coerce.number().default(3),

  // Seats
  DEFAULT_SEAT_COUNT: z.coerce.number().default(15),

  // Laravel Events (Redis pub/sub)
  MSAB_EVENTS_CHANNEL: z.string().default("flylive:msab:events"),
  MSAB_EVENTS_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Security
  CORS_ORIGINS: z
    .string()
    .default("https://flyliveapp.com,https://www.flyliveapp.com")
    .transform((s) => s.split(",").map((o) => o.trim())),
});

export type Config = z.infer<typeof configSchema>;

/** Validated configuration object - fails fast on invalid config */
export const config: Config = configSchema.parse(process.env);

/** Type-safe config access */
export const isDev = config.NODE_ENV === "development";
export const isProd = config.NODE_ENV === "production";
