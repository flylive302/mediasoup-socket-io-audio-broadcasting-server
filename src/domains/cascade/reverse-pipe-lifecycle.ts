/**
 * ReversePipeLifecycle — owns the reverse-pipe state on edge instances.
 *
 * Edge speakers produce locally; this class opens a reverse pipe to origin so
 * origin (and other edges) can hear them. It owns the `reversedProducers` Map
 * and all methods that set up, connect, and tear down those pipes.
 *
 * CascadeCoordinator delegates to this class for all reverse-pipe operations.
 */
import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import { metrics } from "@src/infrastructure/metrics.js";
import type { PipeManager } from "@src/domains/media/pipe-manager.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import type { ReverseOfferResponse, ReverseFinalizeResponse } from "./types.js";

const PIPE_REQUEST_TIMEOUT_MS = 10_000;

export class ReversePipeLifecycle {
  /**
   * Reverse-pipe state on edge instances.
   * Edge speakers produce locally; we open a reverse pipe to origin so origin
   * (and other edges) can hear them.
   *
   *   roomId → (edgeProducerId → { outboundTransport, originProducerId })
   */
  private readonly reversedProducers = new Map<
    string,
    Map<
      string,
      {
        outboundTransport: import("mediasoup").types.PlainTransport;
        /** Origin's transport id from /reverse-offer.
         *  F-35: null while the entry is "pending" (cached before the offer
         *  round-trip so a disconnect during Phase 1→2 is still cleanable). */
        originTransportId: string | null;
        /** null until finalize completes. */
        originProducerId: string | null;
      }
    >
  >();

  constructor(
    private readonly pipeManager: PipeManager,
    /** Shared reference from CascadeCoordinator — read-only here. */
    private readonly originUrls: ReadonlyMap<string, string>,
    private readonly logger: Logger,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  async setupReversePipe(
    roomId: string,
    edgeProducer: import("mediasoup").types.Producer,
    cluster: RoomMediaCluster,
    userId: number,
  ): Promise<{ originProducerId: string } | null> {
    const cached = this.reversedProducers.get(roomId)?.get(edgeProducer.id);
    if (cached) {
      if (cached.originProducerId === null) return null;
      return { originProducerId: cached.originProducerId };
    }

    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) {
      this.logger.warn(
        { roomId, edgeProducerId: edgeProducer.id },
        "setupReversePipe: not an edge for this room (no originUrl)",
      );
      return null;
    }

    const router = cluster.router;
    if (!router) {
      this.logger.error(
        { roomId, edgeProducerId: edgeProducer.id },
        "setupReversePipe: cluster has no source router",
      );
      return null;
    }

    let outbound: Awaited<
      ReturnType<PipeManager["createReverseOutboundTransport"]>
    > | null = null;

    try {
      outbound = await this.pipeManager.createReverseOutboundTransport(router, roomId);

      // F-35: register a PENDING cache entry before the offer round-trip so
      // a disconnect during Phase 1→2 is still cleanable by closeReversePipe.
      let perRoom = this.reversedProducers.get(roomId);
      if (!perRoom) {
        perRoom = new Map();
        this.reversedProducers.set(roomId, perRoom);
      }
      perRoom.set(edgeProducer.id, {
        outboundTransport: outbound.transport,
        originTransportId: null,
        originProducerId: null,
      });

      const edgePublicIp = config.PUBLIC_IP || outbound.ip;

      const offerResponse = await this.requestReverseOffer(
        originBaseUrl,
        roomId,
        edgeProducer.id,
        edgePublicIp,
        outbound.port,
      );
      if (!offerResponse) {
        outbound.transport.close();
        perRoom.delete(edgeProducer.id);
        if (perRoom.size === 0) this.reversedProducers.delete(roomId);
        return null;
      }

      // F-35: if the speaker disconnected during the offer await,
      // closeReversePipe already removed the entry.
      const pendingEntry = perRoom.get(edgeProducer.id);
      if (!pendingEntry) {
        outbound.transport.close();
        await this.notifyOriginReverseClose(
          originBaseUrl,
          roomId,
          edgeProducer.id,
          offerResponse.transportId,
        );
        metrics.reversePipeSetup.inc({ result: "failure" });
        return null;
      }
      pendingEntry.originTransportId = offerResponse.transportId;

      const consumeResult = await this.pipeManager.connectReverseTransport(
        outbound.transport,
        { ip: offerResponse.ip, port: offerResponse.port },
        edgeProducer.id,
        offerResponse.rtpCapabilities,
        roomId,
      );

      const finalizeResponse = await this.requestReverseFinalize(
        originBaseUrl,
        roomId,
        edgeProducer.id,
        offerResponse.transportId,
        consumeResult.consumerKind,
        consumeResult.consumerRtpParameters,
        userId,
      );
      if (!finalizeResponse) {
        await this.closeReversePipe(roomId, edgeProducer.id);
        metrics.reversePipeSetup.inc({ result: "failure" });
        return null;
      }

      const entry = perRoom.get(edgeProducer.id);
      if (entry) {
        entry.originProducerId = finalizeResponse.originProducerId;
      } else {
        // F-35: cancelled during Phase 3/4.
        outbound?.transport.close();
        await this.notifyOriginReverseClose(
          originBaseUrl,
          roomId,
          edgeProducer.id,
          offerResponse.transportId,
        );
        metrics.reversePipeSetup.inc({ result: "failure" });
        return null;
      }

      outbound.transport.observer.on("close", () => {
        this.reversedProducers.get(roomId)?.delete(edgeProducer.id);
        if (this.reversedProducers.get(roomId)?.size === 0) {
          this.reversedProducers.delete(roomId);
        }
      });

      this.logger.info(
        {
          roomId,
          edgeProducerId: edgeProducer.id,
          originProducerId: finalizeResponse.originProducerId,
          originIp: offerResponse.ip,
          originPort: offerResponse.port,
          edgeIp: edgePublicIp,
          edgePort: outbound.port,
        },
        "Reverse pipe established (edge speaker → origin)",
      );

      metrics.reversePipeSetup.inc({ result: "success" });
      return { originProducerId: finalizeResponse.originProducerId };
    } catch (err) {
      this.logger.error(
        { err, roomId, edgeProducerId: edgeProducer.id },
        "setupReversePipe: failed",
      );
      if (outbound && !outbound.transport.closed) {
        outbound.transport.close();
      }
      this.reversedProducers.get(roomId)?.delete(edgeProducer.id);
      metrics.reversePipeSetup.inc({ result: "failure" });
      return null;
    }
  }

  async closeReversePipe(roomId: string, edgeProducerId: string): Promise<void> {
    const perRoom = this.reversedProducers.get(roomId);
    const entry = perRoom?.get(edgeProducerId);
    if (!entry) return;

    perRoom!.delete(edgeProducerId);
    if (perRoom!.size === 0) this.reversedProducers.delete(roomId);

    try {
      entry.outboundTransport.close();
    } catch {
      // already closed
    }

    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) return;

    await this.notifyOriginReverseClose(
      originBaseUrl,
      roomId,
      edgeProducerId,
      entry.originTransportId,
    );
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private async requestReverseOffer(
    originBaseUrl: string,
    roomId: string,
    edgeProducerId: string,
    edgeIp: string,
    edgePort: number,
  ): Promise<ReverseOfferResponse | null> {
    const url = `${originBaseUrl}/internal/pipe/reverse-offer`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PIPE_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_API_KEY || "",
          },
          body: JSON.stringify({ roomId, edgeProducerId, edgeIp, edgePort }),
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, edgeProducerId, status: response.status },
            "ReversePipeLifecycle: reverse-offer request failed",
          );
          return null;
        }
        return (await response.json()) as ReverseOfferResponse;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error(
        { err, roomId, edgeProducerId },
        "ReversePipeLifecycle: reverse-offer request error",
      );
      return null;
    }
  }

  private async requestReverseFinalize(
    originBaseUrl: string,
    roomId: string,
    edgeProducerId: string,
    transportId: string,
    kind: import("mediasoup").types.MediaKind,
    rtpParameters: import("mediasoup").types.RtpParameters,
    userId: number,
  ): Promise<ReverseFinalizeResponse | null> {
    const url = `${originBaseUrl}/internal/pipe/reverse-finalize`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PIPE_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_API_KEY || "",
          },
          body: JSON.stringify({
            roomId,
            edgeProducerId,
            transportId,
            kind,
            rtpParameters,
            userId,
            edgeInstanceId: config.INSTANCE_ID,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, edgeProducerId, transportId, status: response.status },
            "ReversePipeLifecycle: reverse-finalize request failed",
          );
          return null;
        }
        return (await response.json()) as ReverseFinalizeResponse;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error(
        { err, roomId, edgeProducerId, transportId },
        "ReversePipeLifecycle: reverse-finalize request error",
      );
      return null;
    }
  }

  /**
   * POST /internal/pipe/reverse-close to origin. Best-effort.
   */
  private async notifyOriginReverseClose(
    originBaseUrl: string,
    roomId: string,
    edgeProducerId: string,
    transportId: string | null,
  ): Promise<void> {
    try {
      await fetch(`${originBaseUrl}/internal/pipe/reverse-close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.INTERNAL_API_KEY || "",
        },
        body: JSON.stringify({ roomId, edgeProducerId, transportId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.logger.warn(
        { err, roomId, edgeProducerId },
        "notifyOriginReverseClose: notify origin failed (origin will close on its own when its transport times out)",
      );
    }
  }
}
