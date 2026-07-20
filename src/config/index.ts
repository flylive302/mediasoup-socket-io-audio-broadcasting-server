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
  // Vultr managed Valkey presents a private CA (not in the OS trust store) —
  // path to a mounted CA bundle so `rejectUnauthorized: true` can still verify
  // it. Unset (AWS ElastiCache path): Node's default trust store is used, unchanged.
  REDIS_TLS_CA_PATH: z.string().optional(),

  // JWT Authentication (shared secret with Laravel)
  JWT_SECRET: z.string().min(32),
  // F-56: 24h, matching the Laravel-issued JWT lifetime. Two uses: (1) the no-exp
  // max-age ceiling in jwtValidator (Laravel always sets exp, so rarely hit), and
  // (2) the TTL for `auth:user_revoked:*` Redis keys in the event-router and backfill
  // poller — a revocation only needs to outlive the longest-lived still-valid token.
  JWT_MAX_AGE_SECONDS: z.coerce.number().default(86_400),

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
  // room-seat-caps/01: single source of truth for the maximum seats a room can
  // grow to. Laravel validates seat-count changes against this same ceiling;
  // MSAB trusts backend-validated values within it (Lua seat-index bounds key
  // off RoomState.seatCount, kept in sync via syncRoomSettings in event-router).
  MAX_SEAT_COUNT: z.coerce.number().int().positive().default(30),
  MAX_ROOMS_PER_WORKER: z.coerce.number().default(100),
  MAX_LISTENERS_PER_DISTRIBUTION_ROUTER: z.coerce.number().default(700),
  // realtime-12: presentation-only cap on how many Speakers are surfaced as
  // "talking" in the `speaker:active` event (top-N by recency). Despite the old
  // name (MAX_ACTIVE_SPEAKERS_FORWARDED), it does NOT cap or gate audio — every
  // Speaker's audio is always forwarded to every Listener. Purely a UI highlight
  // count. See CONTEXT.md "Active Speaker".
  UI_ACTIVE_SPEAKER_HIGHLIGHT_COUNT: z.coerce.number().default(6),
  RATE_LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().default(60),
  // Seat Reactions: ~1 per 1.5s per sender (ADR 0015 / seat-reactions slice 01)
  RATE_LIMIT_SEAT_REACTIONS_PER_WINDOW: z.coerce.number().default(1),
  RATE_LIMIT_SEAT_REACTIONS_WINDOW_SECONDS: z.coerce.number().default(1.5),
  // DM Typing indicator: ~1 per 2s per (sender, thread) — dm-realtime-platform/04
  RATE_LIMIT_TYPING_PER_WINDOW: z.coerce.number().default(1),
  RATE_LIMIT_TYPING_WINDOW_SECONDS: z.coerce.number().default(2),
  // F-44: deliberate fail-policy for the rate limiter on a Redis error.
  // Default false = fail-closed (preserves prior production behavior: deny on
  // Redis blip). Set true to fail-open (allow), matching jwtValidator's
  // fail-open revocation lookup — a conscious trade-off, not a silent change.
  RATE_LIMIT_FAIL_OPEN: booleanEnvSchema,

  // Mediasoup Workers
  MEDIASOUP_NUM_WORKERS: z.coerce.number().optional(), // If not set, uses os.cpus().length

  // Room Auto-Close (inactivity timer)
  // AUDIT-021 FIX: increased from 30s to 120s — 30s was too aggressive during network blips
  ROOM_INACTIVITY_TIMEOUT_MS: z.coerce.number().default(120_000), // 2 minutes
  ROOM_AUTO_CLOSE_POLL_INTERVAL_MS: z.coerce.number().default(30_000), // 30 seconds
  // realtime-01: a confirmed-empty room (real socket presence == 0) must stay
  // empty for at least this long before auto-close fires, so a transient zero
  // between poll ticks (reconnect-in-progress) never ejects a returning user.
  ROOM_PRESENCE_GRACE_MS: z.coerce.number().default(15_000), // 15 seconds
  // realtime-22: hold a disconnected SPEAKER's seat this long before releasing
  // it, so a genuine socket death (PWA background-kill, reconnect-failed rebuild,
  // network drop past pingTimeout) that recovers within the window keeps the same
  // slot instead of silently demoting the user to the audience. Deliberately
  // SEPARATE from (and longer than) ROOM_PRESENCE_GRACE_MS: presence-grace is a
  // "is the room empty" debounce between poll ticks; this is a per-user seat hold
  // measured from the moment the socket is declared dead (server-side disconnect
  // fires only AFTER pingTimeout), and must span a client's reconnect/rebuild. It
  // is Redis-backed (a disconnectedAt marker on the seat), not an in-memory timer,
  // so the hold survives the reconnect landing on a different same-region instance.
  SEAT_RETENTION_GRACE_MS: z.coerce.number().default(45_000), // 45 seconds
  // realtime-02: collapse MSAB→Laravel Room status churn to ≤1 update per Room
  // per this window (trailing-edge). Bounds the internal status POST rate so a
  // join/leave storm can no longer flood (and 429-drop against) the backend.
  ROOM_STATUS_COALESCE_WINDOW_MS: z.coerce.number().default(3_000), // 3 seconds

  // realtime-08: interactive↔broadcast flip thresholds (Listener count) with
  // hysteresis. A Room promotes to broadcast at/above UP and demotes back to
  // interactive at/below DOWN; the band between (DOWN < n < UP) holds the
  // current mode so a Room on the boundary can't flap. Validated UP > DOWN.
  ROOM_BROADCAST_THRESHOLD_UP: z.coerce.number().int().positive().default(1500),
  ROOM_BROADCAST_THRESHOLD_DOWN: z.coerce.number().int().positive().default(1000),
  // realtime-19: temporal demote damping. A demote is eligible when listeners fall
  // to/below DOWN, but tearing the broadcast session down (stop → removeRoom wipes
  // R2 → listeners rebuffer) on a single noisy heartbeat is too destructive. Require
  // the demote condition to HOLD continuously for at least this long before acting;
  // promote stays immediate (relieve SFU load fast). Count hysteresis (UP/DOWN) plus
  // this time damping together resist flap. Default 30s; lower in tests.
  ROOM_BROADCAST_DEMOTE_GRACE_MS: z.coerce.number().int().nonnegative().default(30_000),

  // Gift Buffer
  GIFT_BUFFER_FLUSH_INTERVAL_MS: z.coerce.number().default(500),
  GIFT_MAX_RETRIES: z.coerce.number().default(5),
  GIFT_RATE_LIMIT: z.coerce.number().default(330),
  GIFT_RATE_WINDOW: z.coerce.number().default(60),

  // Seats
  DEFAULT_SEAT_COUNT: z.coerce.number().default(15),

  // DM Presence (dm-realtime-platform/07): connection-count presence keyed
  // per-user in shared Redis, no client heartbeat. TTL must comfortably
  // exceed the sweep interval so a single missed sweep tick can't lapse a
  // live connection's key; default 75s TTL / 30s sweep gives 2 full retries
  // of margin before expiry.
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(75),
  PRESENCE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // Cap on ids per presence:subscribe/unsubscribe call — bounds a single
  // socket's inbox-scoped room-join fan-out (open inbox list + open thread
  // is well under this in normal use).
  PRESENCE_SUBSCRIBE_MAX: z.coerce.number().int().positive().default(50),



  // Sentry (msab-sentry epic). SENTRY_DSN is OPTIONAL on purpose: config
  // validation exits the process, and telemetry must never gain the power to
  // take audio down. A missing DSN disables Sentry with a single warning
  // (src/instrument.ts). It cannot reach production silently because
  // cloud-init.sh.tpl asserts it in the required-secrets loop at provision
  // time — loud when nothing is serving traffic, silent at runtime.
  SENTRY_DSN: z.string().url().optional(),
  // Must be the IDENTICAL `sha-<commit8>` string used at image-build time for
  // the sourcemap upload, else every event mis-attributes its release and the
  // maps silently stop applying. Supplied by cloud-init from the image tag.
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("production"),
  // Crash-path budgets. uncaughtException flushes inside a 3s force-exit
  // deadline; SIGTERM closes after a 120s drain (see src/index.ts).
  SENTRY_FLUSH_MS: z.coerce.number().default(2_000),
  SENTRY_CLOSE_MS: z.coerce.number().default(2_000),
  // Client-side quota control. 30/hour/instance is precisely the sustained
  // rate that keeps a 2-instance fleet inside the ~45,000 errors/month
  // headroom even if a storm never stops; burst 20 lets a real incident
  // report immediately. The bucket is PER-PROCESS — fleet total is
  // N x refill, so revisit this whenever the fleet size changes.
  SENTRY_BUCKET_CAPACITY: z.coerce.number().default(20),
  SENTRY_BUCKET_REFILL_HOUR: z.coerce.number().default(30),

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

  // realtime-09: LL-HLS broadcast publish tier. When a Room flips to broadcast
  // mode (realtime-08 threshold), the server mixes every seated speaker into one
  // HLS stream (FFmpeg) and publishes it to R2 → Cloudflare CDN; passive
  // Listeners play it instead of N WebRTC consumers. All gated behind
  // BROADCAST_HLS_ENABLED (default off). The HLS_R2_* + HLS_PUBLIC_BASE_URL are
  // optional in the schema but REQUIRED-when-enabled (refine below), so default
  // dev/test boots untouched while a misconfigured prod fails fast.
  BROADCAST_HLS_ENABLED: booleanEnvSchema,
  HLS_R2_ENDPOINT: z.string().url().optional(),            // https://<acct>.r2.cloudflarestorage.com
  HLS_R2_ACCESS_KEY_ID: z.string().optional(),
  HLS_R2_SECRET_ACCESS_KEY: z.string().optional(),
  HLS_R2_BUCKET: z.string().optional(),
  HLS_PUBLIC_BASE_URL: z.string().url().optional(),        // https://live.flyliveapp.com (no trailing slash)
  HLS_FFMPEG_PATH: z.string().default("ffmpeg"),
  HLS_WORK_DIR: z.string().default("/tmp/flylive-hls"),
  // Short-segment HLS (R2 is object storage, not an LL-HLS origin): ~1s segments
  // → ~3–5s glass-to-glass, which is the realtime-09 "~2–5s" target.
  HLS_SEGMENT_DURATION_SEC: z.coerce.number().positive().default(1),
  HLS_PLAYLIST_SIZE: z.coerce.number().int().positive().default(6),
  // Topology changes (seat join/leave, moderator force-mute) restart FFmpeg;
  // debounce coalesces a burst into one restart so a flurry of seat changes
  // rebuffers Listeners once, not N times.
  HLS_RESTART_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(1500),
})
  .refine(
    (c) => c.ROOM_BROADCAST_THRESHOLD_UP > c.ROOM_BROADCAST_THRESHOLD_DOWN,
    {
      message:
        "ROOM_BROADCAST_THRESHOLD_UP must be greater than ROOM_BROADCAST_THRESHOLD_DOWN (hysteresis band).",
      path: ["ROOM_BROADCAST_THRESHOLD_UP"],
    },
  )
  .refine(
    (c) =>
      !c.BROADCAST_HLS_ENABLED ||
      Boolean(
        c.HLS_R2_ENDPOINT &&
          c.HLS_R2_ACCESS_KEY_ID &&
          c.HLS_R2_SECRET_ACCESS_KEY &&
          c.HLS_R2_BUCKET &&
          c.HLS_PUBLIC_BASE_URL,
      ),
    {
      message:
        "BROADCAST_HLS_ENABLED=true requires HLS_R2_ENDPOINT, HLS_R2_ACCESS_KEY_ID, HLS_R2_SECRET_ACCESS_KEY, HLS_R2_BUCKET, and HLS_PUBLIC_BASE_URL.",
      path: ["BROADCAST_HLS_ENABLED"],
    },
  )
  .refine(
    (c) => c.PRESENCE_TTL_SECONDS * 1000 > c.PRESENCE_SWEEP_INTERVAL_MS,
    {
      message:
        "PRESENCE_TTL_SECONDS must be greater than PRESENCE_SWEEP_INTERVAL_MS (in seconds) — otherwise a single sweep tick can't outrun expiry.",
      path: ["PRESENCE_TTL_SECONDS"],
    },
  );

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
    // F-16: TURN must be configured in production. STUN-only silently fails
    // for users behind symmetric NAT (common on India/EU mobile carriers) —
    // the prime suspect for "audio won't connect". Fail fast at boot instead
    // of degrading invisibly. Dev/test still boot STUN-only (iceServers.ts).
    if (!config.CLOUDFLARE_TURN_API_KEY || !config.CLOUDFLARE_TURN_KEY_ID) {
      throw new Error(
        "[config] Production requires CLOUDFLARE_TURN_API_KEY and CLOUDFLARE_TURN_KEY_ID. " +
          "STUN-only mode cannot serve users behind symmetric NAT. Set both (Cloudflare Dashboard → Calls → TURN).",
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

