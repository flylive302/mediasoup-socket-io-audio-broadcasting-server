import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import type { OriginParticipant, OriginRoomSnapshot } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;

export class OriginSnapshot {
  constructor(private readonly logger: Logger) {}

  async fetchOriginInstanceId(originBaseUrl: string): Promise<string | null> {
    try {
      const res = await fetch(`${originBaseUrl}/internal/health`, {
        headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { instanceId?: string };
      return body.instanceId?.trim() || null;
    } catch (err) {
      this.logger.warn({ err, originBaseUrl }, "OriginSnapshot: failed to fetch instanceId");
      return null;
    }
  }

  async fetchOriginProducers(
    originBaseUrl: string,
    roomId: string,
  ): Promise<Array<{ producerId: string; userId: number; kind: string }> | null> {
    const url = `${originBaseUrl}/internal/room/${encodeURIComponent(roomId)}/producers`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
          signal: controller.signal,
        });
        if (!response.ok) {
          this.logger.warn(
            { roomId, status: response.status },
            "OriginSnapshot: producers fetch failed",
          );
          return null;
        }
        const body = (await response.json()) as {
          producers: Array<{ producerId: string; userId: number; kind: string }>;
        };
        return body.producers ?? [];
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error({ err, roomId }, "OriginSnapshot: producers fetch error");
      return null;
    }
  }

  async fetchOriginParticipants(
    originBaseUrl: string,
    roomId: string,
  ): Promise<OriginParticipant[] | null> {
    const url = `${originBaseUrl}/internal/room/${encodeURIComponent(roomId)}/participants`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
          signal: controller.signal,
        });
        if (!response.ok) {
          this.logger.warn(
            { roomId, status: response.status },
            "OriginSnapshot: participants fetch failed",
          );
          return null;
        }
        const body = (await response.json()) as { participants: OriginParticipant[] };
        return body.participants ?? [];
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error({ err, roomId }, "OriginSnapshot: participants fetch error");
      return null;
    }
  }

  async fetchOriginRoomSnapshot(
    originBaseUrl: string,
    roomId: string,
    seatCount: number,
  ): Promise<OriginRoomSnapshot | null> {
    const url = `${originBaseUrl}/internal/room/${encodeURIComponent(roomId)}/snapshot?seatCount=${seatCount}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
          signal: controller.signal,
        });
        if (!response.ok) {
          this.logger.warn(
            { roomId, status: response.status },
            "OriginSnapshot: snapshot fetch failed",
          );
          return null;
        }
        return (await response.json()) as OriginRoomSnapshot;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error({ err, roomId }, "OriginSnapshot: snapshot fetch error");
      return null;
    }
  }
}
