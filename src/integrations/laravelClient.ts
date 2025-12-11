import { config } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import type {
  BatchProcessingResult,
  GiftTransaction,
  RoomStatusUpdate,
} from "./types.js";

export class LaravelClient {
  constructor(private readonly logger: Logger) {}

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

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  private async post(endpoint: string, body: unknown): Promise<Response> {
    const url = `${config.LARAVEL_API_URL}${endpoint}`;

    // Timeout after 10 seconds to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${config.LARAVEL_INTERNAL_KEY}`,
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
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      return await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${config.LARAVEL_INTERNAL_KEY}`,
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
