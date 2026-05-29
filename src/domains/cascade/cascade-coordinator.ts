/**
 * Cascade Coordinator — Orchestrates cross-region SFU cascade setup
 *
 * When a user joins a room that is hosted in a different region,
 * this coordinator:
 *  1. Queries Laravel to discover the origin instance
 *  2. Requests pipe transports from the origin via internal API
 *  3. Creates local edge pipes to receive audio
 *  4. Registers the edge in the relay so signaling events cross regions
 *
 * Lifecycle:
 *  - handleCrossRegionJoin(): called from room:join when room not found locally
 *  - handleRemoteNewProducer(): called when relayed audio:newProducer arrives
 *  - cleanup(): called when edge or origin closes
 */
import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import { metrics } from "@src/infrastructure/metrics.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { PipeManager } from "@src/domains/media/pipe-manager.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RoomRegistry, InstanceInfo } from "@src/domains/room/room-registry.js";
import type { CascadeRelay } from "./cascade-relay.js";
import type {
  CascadeJoinResult,
  RemoteInstance,
  ReverseOfferResponse,
  ReverseFinalizeResponse,
} from "./types.js";
import { EdgePipeLifecycle } from "./edge-pipe-lifecycle.js";

// ─── Constants ──────────────────────────────────────────────────

const PIPE_REQUEST_TIMEOUT_MS = 10_000;

// Same-region origin-init race recovery — see RoomRegistry.claimOwnership docs.
const OWNER_POLL_ATTEMPTS = 5;
const OWNER_POLL_INTERVAL_MS = 200;

// ─── Coordinator ────────────────────────────────────────────────

export class CascadeCoordinator {
  /** roomId → origin base URL (only set on edge instances) */
  private readonly originUrls = new Map<string, string>();

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

  private readonly selfId: string;
  private readonly selfRegion: string;

  /** Handles the edge-side pipe idempotency cache and all pipe create/reuse/cleanup. */
  private readonly edgePipeLifecycle: EdgePipeLifecycle;

  constructor(
    roomManager: RoomManager,
    private readonly pipeManager: PipeManager,
    private readonly roomRegistry: RoomRegistry,
    private readonly laravelClient: LaravelClient,
    private readonly cascadeRelay: CascadeRelay,
    private readonly logger: Logger,
  ) {
    this.selfId = config.INSTANCE_ID;
    this.selfRegion = config.AWS_REGION;
    // originUrls is a shared reference — EdgePipeLifecycle reads from it so it
    // can resolve the origin URL for pipe-offer/notify calls without needing
    // a separate URL argument on every method.
    this.edgePipeLifecycle = new EdgePipeLifecycle(
      pipeManager,
      roomManager,
      this.originUrls,
      logger,
    );
  }

  // ─── Cross-Region Join ────────────────────────────────────────

  /**
   * Check if a room exists remotely and set up edge piping if needed.
   *
   * Called from room:join when getRoom(roomId) returns null locally.
   * If the room is live on another region, this instance becomes an edge.
   */
  async handleCrossRegionJoin(roomId: string): Promise<CascadeJoinResult> {
    if (!config.CASCADE_ENABLED) {
      return { isEdge: false };
    }

    const cascadeInfo = await this.laravelClient.getCascadeInfo(roomId);

    if (!cascadeInfo.is_live || !cascadeInfo.hosting_region) {
      this.logger.debug({ roomId }, "CascadeCoordinator: room not live remotely");
      return { isEdge: false };
    }

    if (cascadeInfo.hosting_region === this.selfRegion) {
      this.logger.debug({ roomId }, "CascadeCoordinator: room in same region, skipping cascade");
      return { isEdge: false };
    }

    if (!cascadeInfo.hosting_ip || !cascadeInfo.hosting_port) {
      this.logger.warn(
        { roomId, cascadeInfo },
        "CascadeCoordinator: cross-region room missing hosting_ip/port",
      );
      return { isEdge: false };
    }

    const originBaseUrl = `http://${cascadeInfo.hosting_ip}:${cascadeInfo.hosting_port}`;
    const originInstanceId = await this.fetchOriginInstanceId(originBaseUrl);
    if (!originInstanceId) {
      this.logger.warn(
        { roomId, originBaseUrl },
        "CascadeCoordinator: cannot attach to cross-region origin without instanceId",
      );
      return { isEdge: false };
    }

    await this.attachToOrigin(
      roomId,
      cascadeInfo.hosting_ip,
      cascadeInfo.hosting_port,
      originInstanceId,
    );

    this.logger.info(
      {
        roomId,
        originRegion: cascadeInfo.hosting_region,
        originIp: cascadeInfo.hosting_ip,
        selfRegion: this.selfRegion,
      },
      "CascadeCoordinator: cross-region room detected, becoming edge",
    );

    return {
      isEdge: true,
      originIp: cascadeInfo.hosting_ip,
      originPort: cascadeInfo.hosting_port,
      originRegion: cascadeInfo.hosting_region,
    };
  }

  // ─── Same-Region Edge ─────────────────────────────────────────

  /**
   * B-1: Set up an edge for an in-region room owned by another instance.
   */
  async handleSameRegionEdge(
    roomId: string,
    ownerInstanceId: string,
  ): Promise<CascadeJoinResult> {
    if (!config.CASCADE_ENABLED) {
      return { isEdge: false };
    }

    const origin = await this.waitForOriginInfo(roomId, ownerInstanceId);
    if (!origin) {
      this.logger.warn(
        { roomId, ownerInstanceId },
        "CascadeCoordinator: owner InstanceInfo never appeared (origin init failed?)",
      );
      return { isEdge: false };
    }

    await this.attachToOrigin(roomId, origin.ip, origin.port, origin.instanceId);

    this.logger.info(
      { roomId, ownerInstanceId, originIp: origin.ip, originPort: origin.port },
      "CascadeCoordinator: same-region edge attached",
    );

    return {
      isEdge: true,
      originIp: origin.ip,
      originPort: origin.port,
      originRegion: this.selfRegion,
    };
  }

  // ─── Edge Attachment ──────────────────────────────────────────

  /**
   * Wire local edge state for an origin. Idempotent.
   *
   * Awaits origin-side relay registration so subsequent snapshot fetches
   * see a consistent edge list.
   */
  private async attachToOrigin(
    roomId: string,
    originIp: string,
    originPort: number,
    originInstanceId: string,
  ): Promise<void> {
    const originBaseUrl = `http://${originIp}:${originPort}`;
    this.originUrls.set(roomId, originBaseUrl);

    const originInstance: RemoteInstance = {
      instanceId: originInstanceId,
      baseUrl: originBaseUrl,
    };
    this.cascadeRelay.registerRemote(roomId, originInstance);

    try {
      await this.edgePipeLifecycle.notifyOriginEdgeRegistered(originBaseUrl, roomId);
    } catch (err) {
      this.logger.error({ err, roomId }, "CascadeCoordinator: failed to notify origin");
    }
  }

  private async waitForOriginInfo(
    roomId: string,
    ownerInstanceId: string,
  ): Promise<InstanceInfo | null> {
    for (let attempt = 0; attempt < OWNER_POLL_ATTEMPTS; attempt++) {
      const origin = await this.roomRegistry.getOrigin(roomId);
      if (origin && origin.instanceId === ownerInstanceId) {
        return origin;
      }
      await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_INTERVAL_MS));
    }
    return null;
  }

  // ─── Pipe Setup (delegates to EdgePipeLifecycle) ───────────────

  async requestPipeForProducer(
    roomId: string,
    producerId: string,
    cluster: RoomMediaCluster,
  ): Promise<string | null> {
    return this.edgePipeLifecycle.requestPipeForProducer(roomId, producerId, cluster);
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  async cleanup(roomId: string): Promise<void> {
    // Drain in-flight setups, notify origin of disconnect, clear pipe Maps.
    await this.edgePipeLifecycle.cleanupRoom(roomId);

    // Close all mediasoup pipe transports for the room.
    await this.pipeManager.closePipes(roomId);

    // Clean up relay registrations.
    this.cascadeRelay.cleanupRoom(roomId);

    // Remove edge state — must come after cleanupRoom reads originUrls.
    this.originUrls.delete(roomId);

    this.logger.debug({ roomId }, "CascadeCoordinator: room cascade cleanup complete");
  }

  isEdgeRoom(roomId: string): boolean {
    return this.originUrls.has(roomId);
  }

  // ─── Edge Bootstrap ───────────────────────────────────────────

  async fetchAndPipeExistingProducers(
    roomId: string,
    cluster: RoomMediaCluster,
  ): Promise<Array<{ producerId: string; userId: number }>> {
    if (!this.isEdgeRoom(roomId)) return [];
    return this.edgePipeLifecycle.fetchAndPipeExistingProducers(roomId, cluster);
  }

  // ─── Participant Discovery ─────────────────────────────────────

  async fetchOriginParticipants(
    roomId: string,
  ): Promise<Array<{
    id: number;
    name: string;
    signature: string;
    avatar: string;
    frame_id: number | null;
    chat_bubble_id: number | null;
    entry_animation_id: number | null;
    data_card_id: number | null;
    mice_wave_id: number | null;
    slides_id: number | null;
    gender: number;
    country: string;
    wealth_xp: string;
    charm_xp: string;
    vip_level: number;
    isSpeaker: boolean;
  }> | null> {
    if (!this.isEdgeRoom(roomId)) return null;

    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) return null;

    const url = `${originBaseUrl}/internal/room/${encodeURIComponent(roomId)}/participants`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PIPE_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, status: response.status },
            "CascadeCoordinator: origin participants fetch failed",
          );
          return null;
        }

        const body = (await response.json()) as {
          status: string;
          participants: Array<{
            id: number;
            name: string;
            signature: string;
            avatar: string;
            frame_id: number | null;
            chat_bubble_id: number | null;
            entry_animation_id: number | null;
            data_card_id: number | null;
            mice_wave_id: number | null;
            slides_id: number | null;
            gender: number;
            country: string;
            wealth_xp: string;
            charm_xp: string;
            vip_level: number;
            isSpeaker: boolean;
          }>;
        };
        return body.participants ?? [];
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error({ err, roomId }, "CascadeCoordinator: origin participants fetch error");
      return null;
    }
  }

  // ─── Room Snapshot ─────────────────────────────────────────────

  async fetchOriginRoomSnapshot(
    roomId: string,
    seatCount: number,
  ): Promise<{
    seats: Array<{ seatIndex: number; userId: number; isMuted: boolean }>;
    lockedSeats: number[];
    seatCount: number;
    musicPlayer: {
      userId: number;
      title: string;
      duration: number;
      position: number;
      isPaused: boolean;
    } | null;
  } | null> {
    if (!this.isEdgeRoom(roomId)) return null;

    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) return null;

    const url = `${originBaseUrl}/internal/room/${encodeURIComponent(roomId)}/snapshot?seatCount=${seatCount}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PIPE_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, status: response.status },
            "CascadeCoordinator: origin snapshot fetch failed",
          );
          return null;
        }

        return (await response.json()) as Awaited<
          ReturnType<CascadeCoordinator["fetchOriginRoomSnapshot"]>
        >;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error({ err, roomId }, "CascadeCoordinator: origin snapshot fetch error");
      return null;
    }
  }

  // ─── Remote Event Handlers ────────────────────────────────────

  async handleRemoteProducerClosed(roomId: string, producerId: string): Promise<string | null> {
    if (!this.isEdgeRoom(roomId)) return null;
    return this.edgePipeLifecycle.handleRemoteProducerClosed(roomId, producerId);
  }

  async handleRemoteNewProducer(roomId: string, producerId: string): Promise<string | null> {
    if (!this.isEdgeRoom(roomId)) return null;
    return this.edgePipeLifecycle.handleRemoteNewProducer(roomId, producerId);
  }

  async handleOriginClosed(roomId: string): Promise<void> {
    if (!this.isEdgeRoom(roomId)) return;

    this.logger.info({ roomId }, "CascadeCoordinator: origin closed, tearing down edge");
    await this.cleanup(roomId);
  }

  // ─── Reverse pipe (edge speaker → origin) ─────────────────────

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

  // ─── Private Helpers ──────────────────────────────────────────

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
            "CascadeCoordinator: reverse-offer request failed",
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
        "CascadeCoordinator: reverse-offer request error",
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
            edgeInstanceId: this.selfId,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, edgeProducerId, transportId, status: response.status },
            "CascadeCoordinator: reverse-finalize request failed",
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
        "CascadeCoordinator: reverse-finalize request error",
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

  private async fetchOriginInstanceId(originBaseUrl: string): Promise<string | null> {
    try {
      const res = await fetch(`${originBaseUrl}/internal/health`, {
        headers: { "X-Internal-Key": config.INTERNAL_API_KEY || "" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { instanceId?: string };
      return body.instanceId?.trim() || null;
    } catch (err) {
      this.logger.warn(
        { err, originBaseUrl },
        "CascadeCoordinator: failed to fetch origin instanceId",
      );
      return null;
    }
  }
}
