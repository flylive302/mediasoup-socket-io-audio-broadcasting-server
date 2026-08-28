import { config } from "@src/config/index.js";
import * as Sentry from "@sentry/node";
import type { Logger } from "@src/infrastructure/logger.js";
import { seenRecently } from "@src/infrastructure/sentry/dedupe.js";
import { currentCorrelationId } from "@src/infrastructure/correlation.js";
import { metrics } from "@src/infrastructure/metrics.js";
import type {
  BatchProcessingResult,
  CascadeInfo,
  GiftTransaction,
  RepinBatchResult,
  RoomStatusUpdate,
} from "./types.js";

/**
 * The correlation header for an outbound call to the API, or nothing outside a correlated
 * operation.
 *
 * This is the return leg. The API stamps `X-Correlation-ID` on calls it makes to this service and
 * adopts the header when one is supplied, so sending it here makes a round trip that starts at a
 * socket event and ends in the API appear as one trace rather than two unrelated halves.
 *
 * Spreading `{}` when there is no ambient identifier is deliberate: an absent header is adopted-or-
 * minted by the API, whereas an empty-string header would be a value it has to reject.
 */
function correlationHeader(): Record<string, string> {
  const correlationId = currentCorrelationId();

  return correlationId === undefined
    ? {}
    : { "X-Correlation-ID": correlationId };
}

const ROLE_CACHE_TTL_MS = 30_000; // 30 seconds
// B-6 FIX: Prevent unbounded growth of roleCache
const ROLE_CACHE_MAX_SIZE = 5_000;
const ROLE_CACHE_PRUNE_INTERVAL_MS = 60_000; // 1 minute

export class LaravelClient {
  private readonly roleCache = new Map<
    string,
    { role: string; expiresAt: number }
  >();
  private roleCachePruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly logger: Logger) {
    // B-6 FIX: Periodic pruner to evict stale entries (same pattern as seat.owner.ts SEAT-004)
    this.roleCachePruneTimer = setInterval(() => {
      this.pruneRoleCache();
    }, ROLE_CACHE_PRUNE_INTERVAL_MS);
    // Allow process to exit without waiting for pruner
    if (this.roleCachePruneTimer.unref) this.roleCachePruneTimer.unref();
  }

  /** Stop the cache pruner (called during graceful shutdown) */
  stopPruner(): void {
    if (this.roleCachePruneTimer) {
      clearInterval(this.roleCachePruneTimer);
      this.roleCachePruneTimer = null;
    }
  }

  /** Evict expired entries from the role cache */
  private pruneRoleCache(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.roleCache) {
      if (entry.expiresAt <= now) {
        this.roleCache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.logger.debug(
        { pruned, remaining: this.roleCache.size },
        "LaravelClient: roleCache pruned",
      );
    }
  }

  /**
   * Send a batch of gifts to Laravel for processing
   */
  async processGiftBatch(
    transactions: GiftTransaction[],
  ): Promise<BatchProcessingResult> {
    // Strip internal socket ID before sending
    const payload = transactions.map(
      ({ sender_socket_id: _sender_socket_id, ...rest }) => rest,
    );

    const response = await this.post("/api/v1/internal/gifts/batch", {
      transactions: payload,
    });

    if (!response.ok) {
      throw new Error(`Gift batch failed: ${response.statusText}`);
    }

    const result = (await response.json()) as BatchProcessingResult;

    // Re-attach socket IDs to failed items so we can notify them
    // We assume order is preserved or IDs match. Using ID match is safer.
    result.failed = result.failed.map((fail) => {
      const original = transactions.find(
        (t) => t.transaction_id === fail.transaction_id,
      );
      if (original?.sender_socket_id) {
        return { ...fail, sender_socket_id: original.sender_socket_id };
      }
      return fail;
    });

    return result;
  }

  /**
   * Notify Laravel about room status changes (closed, live, etc)
   */
  async updateRoomStatus(
    roomId: string,
    status: RoomStatusUpdate,
  ): Promise<void> {
    try {
      const response = await this.post(
        `/api/v1/internal/rooms/${roomId}/status`,
        status,
      );

      if (!response.ok) {
        this.logger.error(
          { status: response.status, roomId },
          "Failed to update room status",
        );
      }
    } catch (error) {
      this.logger.error({ error, roomId }, "Error updating room status");
    }
  }

  /**
   * Fetch cascade routing info for a room.
   * Returns the origin instance's region, IP, and port so edges can connect.
   */
  async getCascadeInfo(roomId: string): Promise<CascadeInfo> {
    try {
      const response = await this.get(
        `/api/v1/internal/rooms/${roomId}/cascade-info`,
      );

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, roomId },
          "Failed to fetch cascade info",
        );
        return {
          hosting_region: null,
          hosting_ip: null,
          hosting_port: null,
          is_live: false,
        };
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        hosting_region: (data.hosting_region as string) ?? null,
        hosting_ip: (data.hosting_ip as string) ?? null,
        hosting_port:
          typeof data.hosting_port === "number" ? data.hosting_port : null,
        is_live: data.is_live === true,
      };
    } catch (error) {
      this.logger.error({ error, roomId }, "Error fetching cascade info");
      return {
        hosting_region: null,
        hosting_ip: null,
        hosting_port: null,
        is_live: false,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  private async post(endpoint: string, body: unknown): Promise<Response> {
    const url = `${config.LARAVEL_API_URL}${endpoint}`;
    const metricsLabel = metricsEndpointLabel(endpoint);
    const startedAt = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.LARAVEL_API_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Internal-Key": config.LARAVEL_INTERNAL_KEY,
          // F-64: per-instance throttle key so MSAB instances don't share one bucket
          "X-Instance-ID": config.INSTANCE_ID,
          ...correlationHeader(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      recordLaravelApiCall(metricsLabel, String(response.status), startedAt);
      return response;
    } catch (error) {
      recordLaravelApiCall(
        metricsLabel,
        laravelFailureStatus(error),
        startedAt,
      );
      captureLaravelFailure("POST", endpoint, error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async get(endpoint: string): Promise<Response> {
    const url = `${config.LARAVEL_API_URL}${endpoint}`;
    const metricsLabel = metricsEndpointLabel(endpoint);
    const startedAt = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.LARAVEL_API_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Internal-Key": config.LARAVEL_INTERNAL_KEY,
          // F-64: per-instance throttle key so MSAB instances don't share one bucket
          "X-Instance-ID": config.INSTANCE_ID,
          ...correlationHeader(),
        },
        signal: controller.signal,
      });
      recordLaravelApiCall(metricsLabel, String(response.status), startedAt);
      return response;
    } catch (error) {
      recordLaravelApiCall(
        metricsLabel,
        laravelFailureStatus(error),
        startedAt,
      );
      captureLaravelFailure("GET", endpoint, error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Periodic liveness heartbeat for Laravel's placement registry
   * (aws-production/24 follow-up). Before this, the registry was fed only by
   * room-status posts — an idle, freshly booted box never appeared, so it
   * never received rooms and drains onto it moved nothing. Never throws.
   */
  async sendInstanceHeartbeat(region: string): Promise<boolean> {
    try {
      const response = await this.post("/api/v1/internal/instances/heartbeat", {
        region,
      });

      if (!response.ok) {
        this.logger.warn(
          { status: response.status },
          "Instance heartbeat rejected",
        );
      }

      return response.ok;
    } catch (error) {
      this.logger.warn({ error }, "Instance heartbeat failed");
      return false;
    }
  }

  /**
   * Mark THIS instance draining (true) or back in service (false) in
   * Laravel's placement registry (aws-production/20). Identity travels via
   * the X-Instance-ID header every call already carries — Laravel refuses
   * payload-named instances, so MSAB can only ever drain itself.
   * Returns whether Laravel acknowledged; never throws (drain must proceed
   * even when Laravel is unreachable).
   */
  async setInstanceDraining(draining: boolean): Promise<boolean> {
    try {
      const response = await this.post("/api/v1/internal/instances/draining", {
        draining,
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, draining },
          "Failed to set instance draining flag",
        );
      }

      return response.ok;
    } catch (error) {
      this.logger.error(
        { error, draining },
        "Error setting instance draining flag",
      );
      return false;
    }
  }

  /**
   * Ask Laravel to re-pin one bounded batch of this instance's Rooms to
   * healthy instances (aws-production/20). Returns Laravel's honest batch
   * counts, or null on any failure — callers decide whether to retry.
   */
  async repinRooms(limit: number): Promise<RepinBatchResult | null> {
    try {
      const response = await this.post(
        "/api/v1/internal/instances/repin-rooms",
        {
          limit,
        },
      );

      if (!response.ok) {
        this.logger.error(
          { status: response.status },
          "Failed to re-pin rooms batch",
        );
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        repinned: typeof data.repinned === "number" ? data.repinned : 0,
        unplaced: typeof data.unplaced === "number" ? data.unplaced : 0,
        remaining: typeof data.remaining === "number" ? data.remaining : 0,
        held: typeof data.held === "number" ? data.held : 0,
      };
    } catch (error) {
      this.logger.error({ error }, "Error re-pinning rooms batch");
      return null;
    }
  }

  /**
   * Tell Laravel this instance now owns `roomId` (won or reclaimed the CAS
   * claim) so `rooms.pinned_instance` converges on the real owner
   * (room-pin-owner-mismatch/01). REACT: fire-and-forget, never throws —
   * a miss only means the read-time fallback stays stale until the next win.
   */
  async assertRoomPin(roomId: string): Promise<boolean> {
    try {
      const response = await this.post("/api/v1/internal/instances/pin-room", {
        room_id: Number(roomId),
      });

      if (!response.ok) {
        this.logger.warn(
          { roomId, status: response.status },
          "Failed to assert room pin",
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn({ roomId, error }, "Error asserting room pin");
      return false;
    }
  }

  /**
   * Fetch room metadata (including owner_id and, when the backend exposes it,
   * the owner-configured max_seats — room-battery-perf/05 authoritative refetch).
   */
  async getRoomData(
    roomId: string,
  ): Promise<{ owner_id: number; max_seats: number | null }> {
    const response = await this.get(`/api/v1/internal/rooms/${roomId}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch room data: ${response.statusText}`);
    }

    const rawBody = await response.text();
    const sanitizedBody = this.sanitizeBody(rawBody);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (error) {
      this.logger.debug(
        { status: response.status, bodyPreview: sanitizedBody },
        "Laravel getRoomData response body (sanitized)",
      );
      throw new Error(
        `Failed to parse room data JSON (status ${response.status}): ${String(error)}. Body preview: ${sanitizedBody}`,
      );
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.logger.debug(
        { status: response.status, bodyPreview: sanitizedBody },
        "Laravel getRoomData response body (sanitized)",
      );
      throw new Error(
        `Invalid room data shape (status ${response.status}): expected object. Body preview: ${sanitizedBody}`,
      );
    }

    const ownerId = (parsed as { owner_id?: unknown }).owner_id;
    if (typeof ownerId !== "number" || !Number.isFinite(ownerId)) {
      this.logger.debug(
        { status: response.status, bodyPreview: sanitizedBody },
        "Laravel getRoomData response body (sanitized)",
      );
      throw new Error(
        `Invalid or missing owner_id (status ${response.status}): expected finite number, received ${String(ownerId)}. Body preview: ${sanitizedBody}`,
      );
    }

    // Tolerant read: an older backend without max_seats yields null (callers
    // must treat null as "unknown", never as a seat count).
    const maxSeatsRaw = (parsed as { max_seats?: unknown }).max_seats;
    const maxSeats =
      typeof maxSeatsRaw === "number" && Number.isFinite(maxSeatsRaw)
        ? maxSeatsRaw
        : null;

    return { owner_id: ownerId, max_seats: maxSeats };
  }

  /**
   * F-67: fetch user-token revocations recorded at/after `since` (unix
   * seconds). Backs the MSAB revocation backfill poller — recovers
   * revocations whose real-time SNS emit this instance missed.
   */
  async getRevokedSince(since: number): Promise<{
    revoked: Array<{ user_id: number; revoked_at: number }>;
    server_time: number;
  }> {
    const response = await this.get(
      `/api/v1/internal/users/revoked?since=${encodeURIComponent(String(since))}`,
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch revoked users: ${response.status} ${response.statusText}`,
      );
    }

    const parsed = (await response.json()) as {
      revoked?: Array<{ user_id?: unknown; revoked_at?: unknown }>;
      server_time?: unknown;
    };

    const revoked = Array.isArray(parsed.revoked)
      ? parsed.revoked
          .filter(
            (r): r is { user_id: number; revoked_at: number } =>
              typeof r.user_id === "number" && typeof r.revoked_at === "number",
          )
          .map((r) => ({ user_id: r.user_id, revoked_at: r.revoked_at }))
      : [];

    const serverTime =
      typeof parsed.server_time === "number"
        ? parsed.server_time
        : Math.floor(Date.now() / 1000);

    return { revoked, server_time: serverTime };
  }

  /**
   * gift-authority-tick-fanout/09: full gift catalog snapshot for the room
   * server's boot fetch / TTL refresh / `gift.catalog.updated` refresh.
   * Throws on a non-ok response or network error so the caller
   * (catalogCache) can apply its own boot-backoff / keep-last-good policy —
   * unlike most other GET wrappers here, this one does not swallow failures.
   */
  async getGiftCatalog(): Promise<{
    lucky_enabled: boolean;
    gifts: Array<{
      id: number;
      price: number;
      is_active: boolean;
      is_lucky: boolean;
      min_level: number;
      vip_only: boolean;
    }>;
  }> {
    const response = await this.get("/api/v1/internal/gifts/catalog");

    if (!response.ok) {
      throw new Error(
        `Failed to fetch gift catalog: ${response.status} ${response.statusText}`,
      );
    }

    const parsed = (await response.json()) as {
      lucky_enabled?: unknown;
      gifts?: unknown;
    };

    const gifts = Array.isArray(parsed.gifts)
      ? parsed.gifts.filter(
          (
            g,
          ): g is {
            id: number;
            price: number;
            is_active: boolean;
            is_lucky: boolean;
            min_level: number;
            vip_only: boolean;
          } =>
            typeof g === "object" &&
            g !== null &&
            typeof (g as Record<string, unknown>).id === "number",
        )
      : [];

    return {
      lucky_enabled: parsed.lucky_enabled === true,
      gifts,
    };
  }

  /**
   * gift-authority-tick-fanout 11: one user's authoritative balance + version
   * (ticket 07 endpoint) — used to warm a cold ledger key and to force a
   * refresh before a would-reject. `null` on 404 (unknown user); throws on
   * any other failure so balanceSync can count it.
   */
  async getUserBalance(userId: number): Promise<{
    coins: string;
    diamonds: string;
    wealth_xp: string;
    charm_xp: string;
    version: number;
  } | null> {
    const response = await this.get(`/api/v1/internal/users/${userId}/balance`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Failed to fetch user balance: ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as {
      coins: string;
      diamonds: string;
      wealth_xp: string;
      charm_xp: string;
      version: number;
    };
  }

  /**
   * Check if a user is a room admin/owner
   * Returns the user's role in the room or null if not a member
   */
  async getMemberRole(
    roomId: string,
    userId: string,
  ): Promise<"owner" | "admin" | "member" | null> {
    try {
      const response = await this.get(
        `/api/v1/internal/rooms/${roomId}/members/${userId}/role`,
      );

      if (!response.ok) {
        if (response.status === 404) {
          // User not found in room
          return null;
        }
        this.logger.warn(
          { status: response.status, roomId, userId },
          "Failed to fetch member role",
        );
        return null;
      }

      const data = (await response.json()) as { role?: string };
      const role = data.role;

      if (role === "owner" || role === "admin" || role === "member") {
        return role;
      }

      return null;
    } catch (error) {
      this.logger.error(
        { error, roomId, userId },
        "Error fetching member role",
      );
      return null;
    }
  }

  /**
   * Check if user can manage room (is owner or admin).
   * Uses a role cache to avoid redundant HTTP calls.
   *
   * Note: Callers typically call verifyRoomOwner first (which has its own cache),
   * so we only need to check admin role here — no need to re-fetch room data.
   */
  async canManageRoom(roomId: string, userId: string): Promise<boolean> {
    const cacheKey = `${roomId}:${userId}`;
    const cached = this.roleCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.role === "owner" || cached.role === "admin";
      }
      // Evict stale entry to prevent unbounded Map growth
      this.roleCache.delete(cacheKey);
    }

    const role = await this.getMemberRole(roomId, userId);
    if (role) {
      // B-6 FIX: Enforce hard cap — prune first, then only cache if under limit
      if (this.roleCache.size >= ROLE_CACHE_MAX_SIZE) {
        this.pruneRoleCache();
      }
      if (this.roleCache.size < ROLE_CACHE_MAX_SIZE) {
        this.roleCache.set(cacheKey, {
          role,
          expiresAt: Date.now() + ROLE_CACHE_TTL_MS,
        });
      }
    }
    return role === "owner" || role === "admin";
  }

  /**
   * Return a whitespace-collapsed, truncated version of a response body to avoid
   * leaking large or sensitive payloads into error messages or logs.
   */
  private sanitizeBody(rawBody: string, maxLength = 200): string {
    if (!rawBody) {
      return "[empty body]";
    }

    const collapsed = rawBody.replace(/\s+/g, " ").trim();
    if (collapsed.length <= maxLength) {
      return collapsed;
    }

    return `${collapsed.slice(0, maxLength)}... [truncated]`;
  }
}

/**
 * Collapses the variable parts of a path so every call to the same Laravel
 * route groups into ONE Sentry issue.
 *
 * Without this, fingerprinting by the raw endpoint produces one issue per
 * room/user id — thousands of near-identical issues that bury the fact that a
 * single route is down. That is the exact opposite of what fingerprinting by
 * endpoint is for.
 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint
    .split("?")[0]!
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
      "/:id",
    )
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/**
 * The closed set of route templates `post()`/`get()` are labeled with for
 * `laravelApiCalls`/`laravelApiLatency` (observability-audio-quality 14).
 *
 * Deliberately NOT `normalizeEndpoint()` reused as-is: that function is good enough for Sentry
 * ISSUE GROUPING (an occasional extra bucket just means one more issue), but a Prometheus label is a
 * live time series that is never garbage-collected, and `normalizeEndpoint` only collapses segments
 * that already look like a digit run or a UUID. `roomId`/`userId` reach these calls from socket
 * payloads validated only as `z.string().min(1)` (see `src/socket/schemas.ts`) — a caller-supplied
 * value like `"junk-<random>"` would sail through `normalizeEndpoint` untouched and mint a brand new
 * series per value, which is exactly the unbounded-cardinality outcome AC#2 forbids.
 *
 * Matched structurally against the literal templates this class actually calls instead, so the
 * result is always one of a fixed, enumerable set — never a caller-controlled path segment. Anything
 * that doesn't match a known template (there should never be one) falls into "unknown" rather than
 * being echoed raw.
 */
const LARAVEL_ENDPOINT_TEMPLATES: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/v1\/internal\/gifts\/batch$/, "/api/v1/internal/gifts/batch"],
  [/^\/api\/v1\/internal\/gifts\/catalog$/, "/api/v1/internal/gifts/catalog"],
  [
    /^\/api\/v1\/internal\/users\/[^/]+\/balance$/,
    "/api/v1/internal/users/:id/balance",
  ],
  [
    /^\/api\/v1\/internal\/rooms\/[^/]+\/status$/,
    "/api/v1/internal/rooms/:id/status",
  ],
  [
    /^\/api\/v1\/internal\/rooms\/[^/]+\/cascade-info$/,
    "/api/v1/internal/rooms/:id/cascade-info",
  ],
  [
    /^\/api\/v1\/internal\/rooms\/[^/]+\/members\/[^/]+\/role$/,
    "/api/v1/internal/rooms/:id/members/:id/role",
  ],
  [/^\/api\/v1\/internal\/rooms\/[^/]+$/, "/api/v1/internal/rooms/:id"],
  [
    /^\/api\/v1\/internal\/instances\/heartbeat$/,
    "/api/v1/internal/instances/heartbeat",
  ],
  [
    /^\/api\/v1\/internal\/instances\/draining$/,
    "/api/v1/internal/instances/draining",
  ],
  [
    /^\/api\/v1\/internal\/instances\/repin-rooms$/,
    "/api/v1/internal/instances/repin-rooms",
  ],
  [
    /^\/api\/v1\/internal\/instances\/pin-room$/,
    "/api/v1/internal/instances/pin-room",
  ],
  [/^\/api\/v1\/internal\/users\/revoked$/, "/api/v1/internal/users/revoked"],
];

function metricsEndpointLabel(endpoint: string): string {
  const path = endpoint.split("?")[0]!;
  for (const [pattern, label] of LARAVEL_ENDPOINT_TEMPLATES) {
    if (pattern.test(path)) return label;
  }
  return "unknown";
}

/**
 * Emits both dead-until-now metrics (observability-audio-quality 14) from the one place every
 * Laravel API call passes through. `status` is either the response's HTTP status code as a string,
 * or one of the two failure buckets from `laravelFailureStatus` — see the label documentation on
 * `laravelApiCalls` in metrics.ts for the full closed set.
 */
function recordLaravelApiCall(
  endpoint: string,
  status: string,
  startedAt: number,
): void {
  metrics.laravelApiCalls.inc({ endpoint, status });
  metrics.laravelApiLatency.observe(
    { endpoint },
    (Date.now() - startedAt) / 1000,
  );
}

/**
 * Buckets a thrown `fetch` failure into the two closed failure labels for `laravelApiCalls`.
 *
 * Duck-typed on `.name` rather than `error instanceof Error`: the AbortController firing surfaces as
 * a `DOMException` in Node's fetch implementation, not necessarily something that satisfies
 * `instanceof Error` — checking the class would silently mislabel every timeout as a generic
 * "error" and defeat the point of splitting the two out.
 */
function laravelFailureStatus(error: unknown): "timeout" | "error" {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" ? "timeout" : "error";
}

/**
 * Transport-level failure talking to Laravel (DNS, connection refused, TLS,
 * or the AbortController timeout). HTTP error *statuses* are handled by each
 * caller and deliberately not captured here.
 *
 * Deduped per route: a Laravel outage makes every route fail at once and
 * would otherwise drain the whole token bucket in seconds.
 */
function captureLaravelFailure(
  method: "GET" | "POST",
  endpoint: string,
  error: unknown,
): void {
  try {
    const route = normalizeEndpoint(endpoint);
    if (seenRecently(`laravel|${method}|${route}`)) return;

    Sentry.withScope((scope) => {
      scope.setTags({
        stage: "execute",
        laravel_method: method,
        laravel_route: route,
      });
      scope.setFingerprint(["laravel-client", method, route]);
      Sentry.captureException(error, { level: "error" });
    });
  } catch {
    // Telemetry must never break an already-failing integration path.
  }
}
