import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import type {
  BatchProcessingResult,
  CascadeInfo,
  GiftTransaction,
  RoomStatusUpdate,
} from "./types.js";

const ROLE_CACHE_TTL_MS = 30_000; // 30 seconds
// B-6 FIX: Prevent unbounded growth of roleCache
const ROLE_CACHE_MAX_SIZE = 5_000;
const ROLE_CACHE_PRUNE_INTERVAL_MS = 60_000; // 1 minute

export class LaravelClient {
  private readonly roleCache = new Map<string, { role: string; expiresAt: number }>();
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
      this.logger.debug({ pruned, remaining: this.roleCache.size }, "LaravelClient: roleCache pruned");
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
        return { hosting_region: null, hosting_ip: null, hosting_port: null, is_live: false };
      }

      const data = await response.json() as Record<string, unknown>;

      return {
        hosting_region: (data.hosting_region as string) ?? null,
        hosting_ip: (data.hosting_ip as string) ?? null,
        hosting_port: typeof data.hosting_port === "number" ? data.hosting_port : null,
        is_live: data.is_live === true,
      };
    } catch (error) {
      this.logger.error({ error, roomId }, "Error fetching cascade info");
      return { hosting_region: null, hosting_ip: null, hosting_port: null, is_live: false };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  private async post(endpoint: string, body: unknown): Promise<Response> {
    const url = `${config.LARAVEL_API_URL}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.LARAVEL_API_TIMEOUT_MS);

    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Internal-Key": config.LARAVEL_INTERNAL_KEY,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async get(endpoint: string): Promise<Response> {
    const url = `${config.LARAVEL_API_URL}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.LARAVEL_API_TIMEOUT_MS);

    try {
      return await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Internal-Key": config.LARAVEL_INTERNAL_KEY,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch room metadata (including owner_id)
   */
  async getRoomData(roomId: string): Promise<{ owner_id: number }> {
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

    return { owner_id: ownerId };
  }

  /**
   * Check if a user is a room admin/owner
   * Returns the user's role in the room or null if not a member
   */
  async getMemberRole(roomId: string, userId: string): Promise<'owner' | 'admin' | 'member' | null> {
    try {
      const response = await this.get(`/api/v1/internal/rooms/${roomId}/members/${userId}/role`);

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

      const data = await response.json() as { role?: string };
      const role = data.role;
      
      if (role === 'owner' || role === 'admin' || role === 'member') {
        return role;
      }
      
      return null;
    } catch (error) {
      this.logger.error({ error, roomId, userId }, "Error fetching member role");
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
