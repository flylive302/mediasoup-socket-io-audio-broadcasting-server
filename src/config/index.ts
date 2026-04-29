/**
 * Centralized configuration with runtime validation
 * All environment variables validated at startup via Zod
 */
import { z } from "zod";
import "dotenv/config";
import { getInstanceId } from "@src/infrastructure/instance-identity.js";

/** Reusable schema for boolean-like env vars ("true"/"1" → true, else false) */
const booleanEnvSchema = z
  .enum(["true", "false", "1", "0", ""])
  .default("")
  .transform((v) => v === "true" || v === "1");

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
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(3), // Separate DB from Laravel
  REDIS_TLS: booleanEnvSchema,

  // JWT Authentication (shared secret with Laravel)
  JWT_SECRET: z.string().min(32),
  JWT_MAX_AGE_SECONDS: z.coerce.number().default(2_592_000), // 30 days fallback

  // Laravel Integration
  LARAVEL_API_URL: z.string().url(),
  LARAVEL_INTERNAL_KEY: z.string().min(32), // For server-to-server auth
  LARAVEL_API_TIMEOUT_MS: z.coerce.number().default(30_000), // 30 seconds

  // MediaSoup
  MEDIASOUP_LISTEN_IP: z.string().default("0.0.0.0"),
  MEDIASOUP_ANNOUNCED_IP: z.string().optional(), // Public IP for production
  MEDIASOUP_RTC_MIN_PORT: z.coerce.number().default(10000),
  MEDIASOUP_RTC_MAX_PORT: z.coerce.number().default(59999),

  // Limits
  MAX_ROOMS_PER_WORKER: z.coerce.number().default(100),
  MAX_LISTENERS_PER_DISTRIBUTION_ROUTER: z.coerce.number().default(700),
  MAX_ACTIVE_SPEAKERS_FORWARDED: z.coerce.number().default(3),
  RATE_LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().default(60),

  // Mediasoup Workers
  MEDIASOUP_NUM_WORKERS: z.coerce.number().optional(), // If not set, uses os.cpus().length

  // Room Auto-Close (inactivity timer)
  // AUDIT-021 FIX: increased from 30s to 120s — 30s was too aggressive during network blips
  ROOM_INACTIVITY_TIMEOUT_MS: z.coerce.number().default(120_000), // 2 minutes
  ROOM_AUTO_CLOSE_POLL_INTERVAL_MS: z.coerce.number().default(30_000), // 30 seconds

  // Gift Buffer
  GIFT_BUFFER_FLUSH_INTERVAL_MS: z.coerce.number().default(500),
  GIFT_MAX_RETRIES: z.coerce.number().default(5),
  GIFT_RATE_LIMIT: z.coerce.number().default(330),
  GIFT_RATE_WINDOW: z.coerce.number().default(60),

  // Seats
  DEFAULT_SEAT_COUNT: z.coerce.number().default(15),



  // Security
  CORS_ORIGINS: z
    .string()
    .default("https://flyliveapp.com,https://www.flyliveapp.com")
    .transform((s) => new Set(s.split(",").map((o) => o.trim()))),

  // ICE Servers (STUN/TURN for WebRTC NAT traversal)
  ICE_STUN_URLS: z
    .string()
    .default("stun:stun.cloudflare.com:3478,stun:stun.cloudflare.com:53")
    .transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean)),

  // Cloudflare Realtime TURN — dynamic credential generation (recommended)
  // Get from: Cloudflare Dashboard → Calls → Overview → your TURN key
  CLOUDFLARE_TURN_API_KEY: z.string().optional(),  // Bearer token (starts with the long hex)
  CLOUDFLARE_TURN_KEY_ID: z.string().optional(),   // Key ID (short hex, part of the API URL)

  // AWS Region (for cross-region room routing)
  AWS_REGION: z.string().default("ap-south-1"),

  // SFU Cascade (Phase 5)
  CASCADE_ENABLED: booleanEnvSchema,                      // Feature flag, default false
  CASCADE_THRESHOLD: z.coerce.number().default(1800),     // Listeners before spawning edge
  INTERNAL_API_KEY: z.string().default(""),                // Shared secret for instance-to-instance auth
  PUBLIC_IP: z.string().default(""),                       // This instance's public IP (from IMDS or env)
});

/**
 * INSTANCE_ID is intentionally NOT a Zod field — it must come from IMDSv2
 * (or `INSTANCE_ID_OVERRIDE` for local two-instance tests), never from a
 * generic env var. Allowing env to set it would invite split-brain.
 */
export type Config = z.infer<typeof configSchema> & {
  /** Resolved by `initializeConfig()` from IMDSv2 / hostname / test override. */
  INSTANCE_ID: string;
};

/**
 * Validated configuration object — fails fast on invalid env.
 * `INSTANCE_ID` is empty until `initializeConfig()` resolves it; readers must
 * be invoked after that point (the boot sequence in `src/index.ts` enforces
 * this by awaiting `initializeConfig()` before bootstrapping the server).
 */
export const config: Config = {
  ...configSchema.parse(process.env),
  INSTANCE_ID: "",
};

let initialized = false;

/**
 * Resolve runtime-discovered config (instance identity) and run hard
 * production assertions. Must be awaited before any code that reads
 * `config.INSTANCE_ID` or relies on cascade prerequisites.
 */
export async function initializeConfig(): Promise<void> {
  if (initialized) return;

  config.INSTANCE_ID = await getInstanceId();

  if (config.NODE_ENV === "production") {
    if (!config.INSTANCE_ID || config.INSTANCE_ID === "unknown") {
      throw new Error(
        "[config] INSTANCE_ID could not be resolved — IMDSv2 unreachable AND os.hostname() returned empty/unknown. This indicates a real outage, not a config issue.",
      );
    }
    if (config.CASCADE_ENABLED && !config.INTERNAL_API_KEY) {
      throw new Error(
        "[config] CASCADE_ENABLED=true requires INTERNAL_API_KEY. Cross-instance HTTP calls will fail without it.",
      );
    }
    if (config.CASCADE_ENABLED && !config.PUBLIC_IP) {
      throw new Error(
        "[config] CASCADE_ENABLED=true requires PUBLIC_IP. Edges cannot reach this instance for pipe handshakes. (Hint: PUBLIC_IP is set by user-data.sh from IMDSv2 — check its fail-fast logic.)",
      );
    }
  }

  initialized = true;
}

