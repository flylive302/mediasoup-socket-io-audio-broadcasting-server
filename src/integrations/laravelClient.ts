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
}
