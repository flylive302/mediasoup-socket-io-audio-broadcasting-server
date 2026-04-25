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
 *  - handlePipeCleanup(): called when edge or origin closes
 */
import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { PipeManager, PlainTransportInfo } from "@src/domains/media/pipe-manager.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RoomRegistry, InstanceInfo } from "@src/domains/room/room-registry.js";
import type { CascadeRelay } from "./cascade-relay.js";
import type {
  CascadeJoinResult,
  PipeOfferResponse,
  RemoteInstance,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────

const PIPE_REQUEST_TIMEOUT_MS = 10_000;

// Same-region origin-init race recovery — see RoomRegistry.claimOwnership docs.
// Owner has claimed but may not have finished mediasoup router init when an
// edge arrives a few ms later. Poll getOrigin() a handful of times before bailing.
const OWNER_POLL_ATTEMPTS = 5;
const OWNER_POLL_INTERVAL_MS = 200;

// ─── Coordinator ────────────────────────────────────────────────

export class CascadeCoordinator {
  /** roomId → origin base URL (only set on edge instances) */
  private readonly originUrls = new Map<string, string>();

  /** Our instance ID */
  private readonly selfId: string;
  private readonly selfRegion: string;

  constructor(
    private readonly roomManager: RoomManager,
    private readonly pipeManager: PipeManager,
    private readonly roomRegistry: RoomRegistry,
    private readonly laravelClient: LaravelClient,
    private readonly cascadeRelay: CascadeRelay,
    private readonly logger: Logger,
  ) {
    this.selfId = config.PUBLIC_IP || "unknown";
    this.selfRegion = config.AWS_REGION || "unknown";
  }

  // ─── Cross-Region Join ────────────────────────────────────────

  /**
   * Check if a room exists remotely and set up edge piping if needed.
   *
   * Called from room:join when getRoom(roomId) returns null locally.
   * If the room is live on another region, this instance becomes an edge.
   *
   * Returns CascadeJoinResult with isEdge=true if edge setup succeeded.
   */
  async handleCrossRegionJoin(roomId: string): Promise<CascadeJoinResult> {
    // Skip cascade if not enabled
    if (!config.CASCADE_ENABLED) {
      return { isEdge: false };
    }

    // Query Laravel for origin info
    const cascadeInfo = await this.laravelClient.getCascadeInfo(roomId);

    if (!cascadeInfo.is_live || !cascadeInfo.hosting_region) {
      this.logger.debug({ roomId }, "CascadeCoordinator: room not live remotely");
      return { isEdge: false };
    }

    // Same region → not a cross-region case
    if (cascadeInfo.hosting_region === this.selfRegion) {
      this.logger.debug({ roomId }, "CascadeCoordinator: room in same region, skipping cascade");
      return { isEdge: false };
    }

    // Cross-region detected — need origin's IP and port
    if (!cascadeInfo.hosting_ip || !cascadeInfo.hosting_port) {
      this.logger.warn(
        { roomId, cascadeInfo },
        "CascadeCoordinator: cross-region room missing hosting_ip/port",
      );
      return { isEdge: false };
    }

    this.attachToOrigin(roomId, cascadeInfo.hosting_ip, cascadeInfo.hosting_port);

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
   *
   * Called from join-room.handler when this instance loses the Redis CAS
   * for room ownership. Polls RoomRegistry.getOrigin() so we wait out the
   * window between "owner claimed" and "owner finished cluster init."
   *
   * Returns isEdge=true if the owner's InstanceInfo became available and
   * the local edge router was wired up. Returns isEdge=false if the owner
   * never appeared (i.e., the owner died mid-init); the caller should
   * surface an error to the joining client.
   */
  async handleSameRegionEdge(
    roomId: string,
    ownerInstanceId: string,
  ): Promise<CascadeJoinResult> {
    if (!config.CASCADE_ENABLED) {
      // Same-region cascade requires the cascade machinery (pipes, relay).
      // Without it, this instance cannot serve the room — caller surfaces error.
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

    this.attachToOrigin(roomId, origin.ip, origin.port);

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

  // ─── Edge Attachment Helpers ───────────────────────────────────

  /**
   * Wire local edge state for an origin discovered via either Laravel (cross-region)
   * or RoomRegistry (same-region). Idempotent so callers don't need to dedupe.
   */
  private attachToOrigin(roomId: string, originIp: string, originPort: number): void {
    const originBaseUrl = `https://${originIp}:${originPort}`;
    this.originUrls.set(roomId, originBaseUrl);

    const originInstance: RemoteInstance = {
      instanceId: originIp,
      baseUrl: originBaseUrl,
    };
    this.cascadeRelay.registerRemote(roomId, originInstance);

    // Fire-and-forget origin notification — origin uses this to add us to its relay list.
    this.notifyOriginEdgeRegistered(originBaseUrl, roomId).catch((err) =>
      this.logger.error({ err, roomId }, "CascadeCoordinator: failed to notify origin"),
    );
  }

  /**
   * Poll RoomRegistry.getOrigin() until the owner's full InstanceInfo appears.
   * Returns null if the owner didn't publish info within the budget.
   */
  private async waitForOriginInfo(
    roomId: string,
    ownerInstanceId: string,
  ): Promise<InstanceInfo | null> {
    for (let attempt = 0; attempt < OWNER_POLL_ATTEMPTS; attempt++) {
      const origin = await this.roomRegistry.getOrigin(roomId);
      if (origin && origin.instanceId === ownerInstanceId) {
        return origin;
      }
      // Stale origin info pointing at someone other than the current owner
      // means a previous origin was replaced. Keep polling until current owner
      // catches up; if they never do, the bail-out below kicks in.
      await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_INTERVAL_MS));
    }
    return null;
  }

  // ─── Pipe Setup ───────────────────────────────────────────────

  /**
   * Request a pipe from the origin for a specific producer.
   * Creates the edge-side pipe transport that connects to the origin's transport.
   *
   * @returns The local producer ID on the edge (listeners consume from this)
   */
  async requestPipeForProducer(
    roomId: string,
    producerId: string,
    router: import("mediasoup").types.Router,
  ): Promise<string | null> {
    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) {
      this.logger.error({ roomId }, "CascadeCoordinator: no origin URL for room");
      return null;
    }

    try {
      // Request the origin to create a pipe transport
      const offerResponse = await this.requestPipeOffer(originBaseUrl, roomId, producerId);

      if (!offerResponse) {
        return null;
      }

      // Create edge-side pipe pointing at origin's transport
      const originInfo: PlainTransportInfo = {
        transportId: offerResponse.transportId,
        ip: offerResponse.ip,
        port: offerResponse.port,
      };

      const rtpParams = this.buildEdgeRtpParameters();

      const { producer } = await this.pipeManager.createEdgePipe(
        router,
        originInfo,
        rtpParams,
        roomId,
      );

      this.logger.info(
        {
          roomId,
          sourceProducerId: producerId,
          edgeProducerId: producer.id,
          originIp: offerResponse.ip,
          originPort: offerResponse.port,
        },
        "CascadeCoordinator: edge pipe established",
      );

      return producer.id;
    } catch (err) {
      this.logger.error(
        { err, roomId, producerId },
        "CascadeCoordinator: failed to set up edge pipe",
      );
      return null;
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Clean up all cascade state for a room (edge or origin side).
   */
  async cleanup(roomId: string): Promise<void> {
    const originBaseUrl = this.originUrls.get(roomId);

    // If we're an edge, notify origin that we're disconnecting
    if (originBaseUrl) {
      this.notifyOriginPipeClose(originBaseUrl, roomId).catch((err) =>
        this.logger.error({ err, roomId }, "CascadeCoordinator: failed to notify origin of close"),
      );
    }

    // Close all pipes for this room
    await this.pipeManager.closePipes(roomId);

    // Clean up relay registrations
    this.cascadeRelay.cleanupRoom(roomId);

    // Clean up local state
    this.originUrls.delete(roomId);

    this.logger.debug({ roomId }, "CascadeCoordinator: room cascade cleanup complete");
  }

  /**
   * Check if a room is an edge instance (piped from remote origin).
   */
  isEdgeRoom(roomId: string): boolean {
    return this.originUrls.has(roomId);
  }

  // ─── Remote Event Handlers ────────────────────────────────────

  /**
   * Handle a relayed audio:newProducer event on an edge instance.
   * Requests a new pipe from the origin for the newly added producer
   * so edge listeners can hear speakers who joined after the edge was set up.
   */
  async handleRemoteNewProducer(roomId: string, producerId: string): Promise<void> {
    if (!this.isEdgeRoom(roomId)) return;

    const cluster = this.roomManager.getRoom(roomId);
    if (!cluster?.router) {
      this.logger.warn({ roomId, producerId }, "CascadeCoordinator: no local cluster for remote producer");
      return;
    }

    const edgeProducerId = await this.requestPipeForProducer(roomId, producerId, cluster.router);
    if (edgeProducerId) {
      this.logger.info(
        { roomId, sourceProducerId: producerId, edgeProducerId },
        "CascadeCoordinator: piped remote producer to edge",
      );
    }
  }

  /**
   * Handle a relayed room:closed event on an edge instance.
   * Cleans up cascade state and closes the local edge room.
   */
  async handleOriginClosed(roomId: string): Promise<void> {
    if (!this.isEdgeRoom(roomId)) return;

    this.logger.info({ roomId }, "CascadeCoordinator: origin closed, tearing down edge");
    await this.cleanup(roomId);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * POST to origin's /internal/pipe/offer to create a pipe transport.
   */
  private async requestPipeOffer(
    originBaseUrl: string,
    roomId: string,
    producerId: string,
  ): Promise<PipeOfferResponse | null> {
    const url = `${originBaseUrl}/internal/pipe/offer`;

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
          body: JSON.stringify({ roomId, producerId }),
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, producerId, status: response.status },
            "CascadeCoordinator: pipe offer request failed",
          );
          return null;
        }

        return (await response.json()) as PipeOfferResponse;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error(
        { err, roomId, producerId },
        "CascadeCoordinator: pipe offer request error",
      );
      return null;
    }
  }

  /**
   * Notify origin that this edge has registered for a room.
   * Origin registers us as a remote instance for its relay.
   */
  private async notifyOriginEdgeRegistered(
    originBaseUrl: string,
    roomId: string,
  ): Promise<void> {
    const url = `${originBaseUrl}/internal/cascade/relay`;
    const selfBaseUrl = `https://${this.selfId}:${config.PORT}`;

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": config.INTERNAL_API_KEY || "",
      },
      body: JSON.stringify({
        roomId,
        event: "__cascade:edge-registered",
        data: {
          edgeInstanceId: this.selfId,
          edgeBaseUrl: selfBaseUrl,
          edgeRegion: this.selfRegion,
        },
        sourceInstanceId: this.selfId,
      }),
    });
  }

  /**
   * Notify origin to close pipes when this edge disconnects.
   */
  private async notifyOriginPipeClose(
    originBaseUrl: string,
    roomId: string,
  ): Promise<void> {
    const url = `${originBaseUrl}/internal/pipe/close`;

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.INTERNAL_API_KEY || "",
        },
        body: JSON.stringify({
          roomId,
          edgeInstanceId: this.selfId,
        }),
      });
    } catch (err) {
      this.logger.warn(
        { err, roomId },
        "CascadeCoordinator: failed to notify origin pipe close",
      );
    }
  }

  /**
   * Build minimal RTP parameters for the edge-side producer.
   * Uses opus codec which is the standard for audio in mediasoup.
   */
  private buildEdgeRtpParameters(): import("mediasoup").types.RtpParameters {
    return {
      codecs: [
        {
          mimeType: "audio/opus",
          payloadType: 100,
          clockRate: 48000,
          channels: 2,
        },
      ],
      encodings: [{ ssrc: Math.floor(Math.random() * 0xFFFFFFFF) }],
    };
  }
}
