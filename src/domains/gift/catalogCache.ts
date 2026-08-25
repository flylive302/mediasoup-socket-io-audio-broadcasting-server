/**
 * gift-authority-tick-fanout 09: room-server gift catalog cache.
 *
 * Boot fetch never blocks server start — a failure retries with exponential
 * backoff (1s → 30s cap) in the background. `hasCatalog()` is false until the
 * first successful fetch; ⚠️ any money-path caller (cost computation, later
 * tickets' send-time gating) MUST fail CLOSED on `hasCatalog() === false` —
 * this ticket only reads the cache for shadow logging, so nothing here
 * enforces that yet.
 *
 * Refresh runs on a timer at `giftCatalogTtlMs()` (re-read every tick, so a
 * runtime flag flip changes the interval on its NEXT tick) and immediately on
 * `gift.catalog.updated` via `refreshNow()`. A refresh failure (boot already
 * succeeded) keeps the last good catalog and logs a warning — never throws
 * into the caller.
 */
import type { Logger } from "@src/infrastructure/logger.js";
import { giftCatalogTtlMs } from "./flags.js";
import { metrics } from "@src/infrastructure/metrics.js";

export interface CachedGift {
  id: number;
  price: number;
  isActive: boolean;
  isLucky: boolean;
  minLevel: number;
  vipOnly: boolean;
}

interface GiftCatalogSource {
  getGiftCatalog(): Promise<{
    lucky_enabled: boolean;
    gifts: Array<{
      id: number;
      price: number;
      is_active: boolean;
      is_lucky: boolean;
      min_level: number;
      vip_only: boolean;
    }>;
  }>;
}

const BOOT_BACKOFF_INITIAL_MS = 1_000;
const BOOT_BACKOFF_CAP_MS = 30_000;

let catalog: Map<number, CachedGift> = new Map();
let luckyEnabled = true;
let hasLoadedOnce = false;
let lastRefreshAt: number | null = null;

let refreshTimer: NodeJS.Timeout | null = null;
let bootRetryTimer: NodeJS.Timeout | null = null;
let bootBackoffMs = BOOT_BACKOFF_INITIAL_MS;
let stopped = false;

function applySnapshot(snapshot: {
  lucky_enabled: boolean;
  gifts: Array<{
    id: number;
    price: number;
    is_active: boolean;
    is_lucky: boolean;
    min_level: number;
    vip_only: boolean;
  }>;
}): void {
  const next = new Map<number, CachedGift>();
  for (const g of snapshot.gifts) {
    next.set(g.id, {
      id: g.id,
      price: g.price,
      isActive: g.is_active,
      isLucky: g.is_lucky,
      minLevel: g.min_level,
      vipOnly: g.vip_only,
    });
  }
  catalog = next;
  luckyEnabled = snapshot.lucky_enabled;
  hasLoadedOnce = true;
  lastRefreshAt = Date.now();

  // Proof metrics (ticket 09): pushed here rather than pulled via a
  // Prometheus `collect()` hook — see metrics.ts's comment on why this
  // module must not be imported FROM metrics.ts.
  metrics.giftCatalogSize.set(catalog.size);
  metrics.giftCatalogRefreshAgeSeconds.set(0);
}

async function attemptBootFetch(
  laravelClient: GiftCatalogSource,
  logger: Logger,
): Promise<void> {
  if (stopped) return;

  try {
    const snapshot = await laravelClient.getGiftCatalog();
    applySnapshot(snapshot);
    bootBackoffMs = BOOT_BACKOFF_INITIAL_MS;
    logger.info(
      { catalogSize: catalog.size, luckyEnabled },
      "Gift catalog: boot fetch succeeded",
    );
  } catch (err) {
    logger.warn(
      { err, nextRetryMs: bootBackoffMs },
      "Gift catalog: boot fetch failed, retrying with backoff",
    );
    bootRetryTimer = setTimeout(() => {
      bootBackoffMs = Math.min(bootBackoffMs * 2, BOOT_BACKOFF_CAP_MS);
      void attemptBootFetch(laravelClient, logger);
    }, bootBackoffMs);
    bootRetryTimer.unref?.();
  }
}

async function refreshTick(
  laravelClient: GiftCatalogSource,
  logger: Logger,
): Promise<void> {
  if (stopped) return;

  try {
    const snapshot = await laravelClient.getGiftCatalog();
    applySnapshot(snapshot);
  } catch (err) {
    // Boot never succeeded — keep retrying via the boot backoff path instead
    // of silently doing nothing every TTL tick.
    if (!hasLoadedOnce) {
      logger.warn({ err }, "Gift catalog: refresh failed before first boot success");
      return;
    }
    logger.warn(
      { err, catalogSize: catalog.size },
      "Gift catalog: refresh failed, keeping last good catalog",
    );
  }
}

function scheduleRefreshTimer(
  laravelClient: GiftCatalogSource,
  logger: Logger,
): void {
  const tick = (): void => {
    if (stopped) return;
    refreshTick(laravelClient, logger).catch((err) => {
      // refreshTick already catches its own errors — final backstop only.
      logger.warn({ err }, "Gift catalog refresh tick failed");
    });
    refreshTimer = setTimeout(tick, giftCatalogTtlMs());
    refreshTimer.unref?.();
  };

  refreshTimer = setTimeout(tick, giftCatalogTtlMs());
  refreshTimer.unref?.();
}

let activeClient: GiftCatalogSource | null = null;
let activeLogger: Logger | null = null;

/**
 * Start the catalog cache: kicks off the boot fetch (never blocking) and the
 * TTL refresh timer. Safe to call once at process start, next to
 * `startGiftFlags`.
 */
export function startGiftCatalog(
  laravelClient: GiftCatalogSource,
  logger: Logger,
): void {
  if (activeClient) {
    logger.warn("Gift catalog cache already started");
    return;
  }

  stopped = false;
  bootBackoffMs = BOOT_BACKOFF_INITIAL_MS;
  activeClient = laravelClient;
  activeLogger = logger;

  void attemptBootFetch(laravelClient, logger);
  scheduleRefreshTimer(laravelClient, logger);
}

/** Stop all timers (graceful shutdown / tests). */
export function stopGiftCatalog(): void {
  stopped = true;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (bootRetryTimer) {
    clearTimeout(bootRetryTimer);
    bootRetryTimer = null;
  }
  activeClient = null;
  activeLogger = null;
}

/**
 * Force an immediate refresh — called from the event router on
 * `gift.catalog.updated`. No-ops quietly if the cache was never started.
 */
export function refreshNow(): void {
  if (!activeClient || !activeLogger) return;
  refreshTick(activeClient, activeLogger).catch((err) => {
    activeLogger?.warn({ err }, "Gift catalog: event-triggered refresh failed");
  });
}

export function hasCatalog(): boolean {
  return hasLoadedOnce;
}

export function getGift(id: number): CachedGift | undefined {
  return catalog.get(id);
}

export function isLuckyEnabled(): boolean {
  return luckyEnabled;
}

export function catalogSize(): number {
  return catalog.size;
}

export function lastRefreshAgeMs(): number {
  if (lastRefreshAt === null) return Number.POSITIVE_INFINITY;
  return Date.now() - lastRefreshAt;
}

/** Test-only: reset all module state between test files/cases. */
export function __resetGiftCatalogForTests(): void {
  stopGiftCatalog();
  catalog = new Map();
  luckyEnabled = true;
  hasLoadedOnce = false;
  lastRefreshAt = null;
  bootBackoffMs = BOOT_BACKOFF_INITIAL_MS;
}
