/**
 * gift-authority-tick-fanout 03: runtime flag source.
 *
 * Resolution order per flag: durable-Redis hash field → env var → schema
 * default. The Redis hash (`GIFT_FLAGS_REDIS_HASH`, default `gift:flags`) is
 * re-read on its own interval (`GIFT_FLAGS_REFRESH_MS`) so an operator can
 * flip a flag fleet-wide without an instance refresh — no drain, no risk of
 * the 10-minute drain ceiling force-closing rooms.
 *
 * Ships inert: nothing in the codebase reads `getGiftFlags()` / the typed
 * getters yet. An empty hash means every value is exactly the env value —
 * byte-identical to today's behaviour.
 */
import type { Redis } from "ioredis";
import { config, giftFlagShapes } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";

export interface GiftFlags {
  GIFT_BALANCE_AUTHORITY: "off" | "shadow" | "redis";
  GIFT_LEGACY_SHAPE: boolean;
  GIFT_ROOM_TICK_MS: number;
  GIFT_PENDING_TTL_MS: number;
  GIFT_CATALOG_TTL_MS: number;
}

type GiftFlagField = keyof GiftFlags;

const FLAG_FIELDS = Object.keys(giftFlagShapes) as GiftFlagField[];

function envFlags(): GiftFlags {
  return {
    GIFT_BALANCE_AUTHORITY: config.GIFT_BALANCE_AUTHORITY,
    GIFT_LEGACY_SHAPE: config.GIFT_LEGACY_SHAPE,
    GIFT_ROOM_TICK_MS: config.GIFT_ROOM_TICK_MS,
    GIFT_PENDING_TTL_MS: config.GIFT_PENDING_TTL_MS,
    GIFT_CATALOG_TTL_MS: config.GIFT_CATALOG_TTL_MS,
  };
}

/**
 * Pure resolver: Redis hash field → env → default (default is already baked
 * into `env`, since callers always pass the current env-derived `GiftFlags`).
 * A field absent from `hash`, or present but failing its Zod shape, resolves
 * to `env`'s value for that field. `onInvalid` is an optional observability
 * hook (logging lives in the caller, not here) — it does not affect the
 * returned value.
 */
export function resolveGiftFlags(
  hash: Record<string, string>,
  env: GiftFlags,
  onInvalid?: (field: GiftFlagField, rawValue: string) => void,
): GiftFlags {
  const result: GiftFlags = { ...env };

  for (const field of FLAG_FIELDS) {
    const raw = hash[field];
    if (raw === undefined) continue;

    const shape = giftFlagShapes[field];
    const parsed = shape.safeParse(raw);
    if (parsed.success) {
      // Each shape's output type matches its GiftFlags field by construction.
      (result as Record<GiftFlagField, unknown>)[field] = parsed.data;
    } else {
      onInvalid?.(field, raw);
    }
  }

  return result;
}

let current: GiftFlags = envFlags();
let timer: NodeJS.Timeout | null = null;
// One warning per distinct (field, bad value) pair, not per tick — a
// sustained bad value in the hash would otherwise log every refresh forever.
const warnedInvalidValues = new Set<string>();

function logChanges(previous: GiftFlags, next: GiftFlags, logger: Logger): void {
  for (const field of FLAG_FIELDS) {
    if (previous[field] !== next[field]) {
      logger.info(
        {
          flag: field,
          from: previous[field],
          to: next[field],
          instanceId: config.INSTANCE_ID,
        },
        "Gift flag changed",
      );
    }
  }
}

async function refreshTick(redis: Redis, logger: Logger): Promise<void> {
  let hash: Record<string, string>;
  try {
    hash = await redis.hgetall(config.GIFT_FLAGS_REDIS_HASH);
  } catch (err) {
    // Redis error: keep the last known value, never throw into the caller.
    logger.warn(
      { err, hash: config.GIFT_FLAGS_REDIS_HASH },
      "Gift flags: HGETALL failed, keeping last known values",
    );
    return;
  }

  const env = envFlags();
  const next = resolveGiftFlags(hash, env, (field, rawValue) => {
    const key = `${field}:${rawValue}`;
    if (!warnedInvalidValues.has(key)) {
      warnedInvalidValues.add(key);
      logger.warn(
        { flag: field, value: rawValue },
        "Gift flags: invalid Redis value, falling back to env",
      );
    }
  });

  logChanges(current, next, logger);
  current = next;
}

/**
 * Start the 5s (configurable) refresh loop. Initial value is the env — the
 * first Redis read happens on the first tick, not synchronously here, so
 * boot never blocks on (or is broken by) a slow/unreachable Redis.
 */
export function startGiftFlags(redis: Redis, logger: Logger): void {
  if (timer) {
    logger.warn("Gift flags refresher already running");
    return;
  }

  current = envFlags();
  warnedInvalidValues.clear();

  timer = setInterval(() => {
    refreshTick(redis, logger).catch((err) => {
      // refreshTick already catches its own Redis errors; this is a final
      // backstop so a refresher tick can never become an unhandled rejection.
      logger.warn({ err }, "Gift flags refresh tick failed");
    });
  }, config.GIFT_FLAGS_REFRESH_MS);
  timer.unref();

  logger.info(
    { intervalMs: config.GIFT_FLAGS_REFRESH_MS, hash: config.GIFT_FLAGS_REDIS_HASH },
    "Gift flags refresher started",
  );
}

export function stopGiftFlags(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getGiftFlags(): Readonly<GiftFlags> {
  return current;
}

export function giftBalanceAuthority(): GiftFlags["GIFT_BALANCE_AUTHORITY"] {
  return current.GIFT_BALANCE_AUTHORITY;
}

export function giftLegacyShape(): boolean {
  return current.GIFT_LEGACY_SHAPE;
}

export function giftRoomTickMs(): number {
  return current.GIFT_ROOM_TICK_MS;
}

export function giftPendingTtlMs(): number {
  return current.GIFT_PENDING_TTL_MS;
}

export function giftCatalogTtlMs(): number {
  return current.GIFT_CATALOG_TTL_MS;
}
