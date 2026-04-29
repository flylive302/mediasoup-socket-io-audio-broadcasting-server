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
import { metrics } from "@src/infrastructure/metrics.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { PipeManager, PlainTransportInfo } from "@src/domains/media/pipe-manager.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RoomRegistry, InstanceInfo } from "@src/domains/room/room-registry.js";
import type { CascadeRelay } from "./cascade-relay.js";
import type {
  CascadeJoinResult,
  PipeOfferResponse,
  RemoteInstance,
  ReverseOfferResponse,
  ReverseFinalizeResponse,
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

  /**
   * Idempotency cache: roomId → (originProducerId → { edgeProducerId, transport }).
   *
   * - edgeProducerId: returned to callers for the relay-rewrite path so edge
   *   listeners consume against this id instead of origin's.
   * - transport: kept so we can close it (and its UDP port) when origin's
   *   producer closes — closing only the producer would leak the transport.
   *
   * Without this cache, every listener join on an edge would create a new
   * pipe for every existing speaker — at 1K listeners on an edge, origin's
   * outbound bandwidth multiplies 1000× for the same audio.
   */
  private readonly pipedProducers = new Map<
    string,
    Map<string, { edgeProducerId: string; transport: import("mediasoup").types.PlainTransport }>
  >();

  /**
   * In-flight pipe creations keyed by `${roomId}:${producerId}` so concurrent
   * callers requesting the same producer share a single setup attempt
   * instead of racing.
   */
  private readonly pendingPipes = new Map<string, Promise<string | null>>();

  /**
   * In-flight bootstraps keyed by roomId so concurrent listener joins on the
   * same edge share one origin-snapshot fetch instead of N parallel hits.
   */
  private readonly pendingBootstraps = new Map<
    string,
    Promise<Array<{ producerId: string; userId: number }>>
  >();

  /**
   * Reverse-pipe state on edge instances.
   * Edge speakers produce locally; we open a reverse pipe to origin so origin
   * (and other edges) can hear them. Tracked so we can tear down the pipe
   * when the speaker disconnects (closeReversePipe).
   *
   *   roomId → (edgeProducerId → { outboundTransport, originProducerId })
   */
  private readonly reversedProducers = new Map<
    string,
    Map<
      string,
      {
        outboundTransport: import("mediasoup").types.PlainTransport;
        /** Origin's transport id from /reverse-offer — sent on close so
         *  origin can clean partial setups (offer succeeded, finalize didn't). */
        originTransportId: string;
        /** null until finalize completes; close still works without it because
         *  origin can look up by transportId. */
        originProducerId: string | null;
      }
    >
  >();

  /**
   * This instance's identity for relay payloads and CAS comparisons.
   * Distinct from `config.PUBLIC_IP` (reachability) — see config/instance-identity.
   */
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
    this.selfId = config.INSTANCE_ID;
    this.selfRegion = config.AWS_REGION;
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

    // Cross-region cascadeInfo from Laravel only carries reachability
    // (hosting_ip/port). To register origin in the relay map under its real
    // instance-id (so loop-prevention matches `sourceInstanceId` correctly),
    // ask origin who it is via /internal/health.
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

  // ─── Edge Attachment Helpers ───────────────────────────────────

  /**
   * Wire local edge state for an origin discovered via either Laravel (cross-region)
   * or RoomRegistry (same-region). Idempotent so callers don't need to dedupe.
   *
   * Awaits the origin-side relay registration so any subsequent snapshot
   * fetch (fetchAndPipeExistingProducers) is guaranteed to be in origin's
   * relay list — without this, a speaker producing in the gap between
   * "edge sent notify" and "origin processed it" would miss this edge,
   * and the snapshot fetch wouldn't see them yet either.
   */
  private async attachToOrigin(
    roomId: string,
    originIp: string,
    originPort: number,
    originInstanceId: string,
  ): Promise<void> {
    const originBaseUrl = `http://${originIp}:${originPort}`;
    this.originUrls.set(roomId, originBaseUrl);

    // CRITICAL: instanceId here MUST equal origin's selfId (from config.INSTANCE_ID
    // on origin's side). cascadeRelay.relayToRemote() uses this as the map key
    // and excludes it when forwarding events whose `sourceInstanceId` matches.
    // A mismatched key would make every relayed event bounce back to origin.
    const originInstance: RemoteInstance = {
      instanceId: originInstanceId,
      baseUrl: originBaseUrl,
    };
    this.cascadeRelay.registerRemote(roomId, originInstance);

    try {
      await this.notifyOriginEdgeRegistered(originBaseUrl, roomId);
    } catch (err) {
      // Don't fail the join — if notify fails, the snapshot fetch still gets
      // a consistent view of producers, and the user can rejoin to retry
      // relay registration. Log so it's visible.
      this.logger.error({ err, roomId }, "CascadeCoordinator: failed to notify origin");
    }
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
   * Creates the edge-side pipe transport that connects to the origin's transport,
   * then registers the resulting producer with the local cluster so it pipes to
   * all distribution routers — without that registration, edge listeners can't
   * consume because canConsume()/consume() resolve via the cluster's piped map.
   *
   * @returns The local producer ID on the edge (listeners consume from this)
   */
  async requestPipeForProducer(
    roomId: string,
    producerId: string,
    cluster: RoomMediaCluster,
  ): Promise<string | null> {
    // Cache hit: this producer is already piped to the local edge.
    const existing = this.pipedProducers.get(roomId)?.get(producerId);
    if (existing) {
      return existing.edgeProducerId;
    }

    // In-flight: another caller is already piping this producer. Coalesce.
    const inflightKey = `${roomId}:${producerId}`;
    const pending = this.pendingPipes.get(inflightKey);
    if (pending) {
      return pending;
    }

    const promise = this.doRequestPipeForProducer(roomId, producerId, cluster);
    this.pendingPipes.set(inflightKey, promise);
    try {
      // doRequestPipeForProducer writes its own cache entry (because it has
      // the transport ref); we only need to await and propagate the id.
      return await promise;
    } finally {
      this.pendingPipes.delete(inflightKey);
    }
  }

  /**
   * Actual pipe-creation work. Wrapped by requestPipeForProducer for caching
   * and concurrent-call coalescing. Don't call directly — use the wrapper.
   */
  private async doRequestPipeForProducer(
    roomId: string,
    producerId: string,
    cluster: RoomMediaCluster,
  ): Promise<string | null> {
    const router = cluster.router;
    if (!router) {
      this.logger.error({ roomId }, "CascadeCoordinator: cluster has no source router");
      return null;
    }

    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) {
      this.logger.error({ roomId }, "CascadeCoordinator: no origin URL for room");
      return null;
    }

    let edgeListener: Awaited<ReturnType<PipeManager["createEdgeListener"]>> | null = null;
    try {
      // Phase 1: create the edge's PlainTransport up-front so we have a
      // concrete listen address to give to the origin. Origin needs this to
      // call connect() before consume() — without it, origin's transport
      // has no destination and the pipe is silent.
      edgeListener = await this.pipeManager.createEdgeListener(router, roomId);

      // Use the instance's PUBLIC_IP if available so origin can reach us
      // across the public network — tuple.localAddress is 0.0.0.0.
      const edgePublicIp = config.PUBLIC_IP || edgeListener.ip;

      // Phase 2: ask origin to create its transport, .connect() to us, and
      // consume the producer using OUR rtpCapabilities. Origin returns its
      // address plus the consumer.rtpParameters we must mirror in produce()
      // so SSRC/PT match.
      const offerResponse = await this.requestPipeOffer(
        originBaseUrl,
        roomId,
        producerId,
        edgePublicIp,
        edgeListener.port,
        router.rtpCapabilities,
      );

      if (!offerResponse) {
        // Close the listener we created — origin won't be sending anything.
        edgeListener.transport.close();
        return null;
      }

      // Phase 3: connect our transport to origin's address and produce with
      // the rtpParameters origin's consumer negotiated for us.
      const originInfo: PlainTransportInfo = {
        transportId: offerResponse.transportId,
        ip: offerResponse.ip,
        port: offerResponse.port,
      };

      const { producer } = await this.pipeManager.createEdgePipeFromTransport(
        edgeListener.transport,
        originInfo,
        offerResponse.kind,
        offerResponse.rtpParameters,
        roomId,
      );

      // Register with the cluster so it gets piped to all distribution routers.
      // Without this, listeners on dist routers can't consume — canConsume() and
      // consume() both resolve via the cluster's pipedProducerMap, which is only
      // populated by registerProducer().
      await cluster.registerProducer(producer);

      // Cache both producer-id and transport so handleRemoteProducerClosed
      // can close the transport too (closing only the producer leaks the UDP
      // port). Done here rather than in the wrapper because we have the
      // transport ref in this scope.
      let roomMap = this.pipedProducers.get(roomId);
      if (!roomMap) {
        roomMap = new Map();
        this.pipedProducers.set(roomId, roomMap);
      }
      roomMap.set(producerId, { edgeProducerId: producer.id, transport: edgeListener.transport });

      // Drop the cache entry if origin's producer (and therefore our pipe)
      // closes — next caller should re-pipe instead of returning a stale id.
      producer.on("transportclose", () => {
        this.pipedProducers.get(roomId)?.delete(producerId);
      });

      this.logger.info(
        {
          roomId,
          sourceProducerId: producerId,
          edgeProducerId: producer.id,
          originIp: offerResponse.ip,
          originPort: offerResponse.port,
          edgeIp: edgePublicIp,
          edgePort: edgeListener.port,
        },
        "CascadeCoordinator: edge pipe established",
      );

      return producer.id;
    } catch (err) {
      this.logger.error(
        { err, roomId, producerId },
        "CascadeCoordinator: failed to set up edge pipe",
      );
      // Clean up the listener if phase 2 or 3 threw.
      if (edgeListener && !edgeListener.transport.closed) {
        edgeListener.transport.close();
      }
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
    this.pipedProducers.delete(roomId);

    this.logger.debug({ roomId }, "CascadeCoordinator: room cascade cleanup complete");
  }

  /**
   * Check if a room is an edge instance (piped from remote origin).
   */
  isEdgeRoom(roomId: string): boolean {
    return this.originUrls.has(roomId);
  }

  // ─── Edge Bootstrap (B-1 Stage 2d) ─────────────────────────────

  /**
   * Fetch the origin's full source-producer list and set up an edge-side pipe
   * for each. Used during room:join on an edge so the joining listener gets
   * edge-LOCAL producer IDs in their `existingProducers` payload — without
   * this step, an edge would only know about producers that joined AFTER the
   * edge was attached (via relayed audio:newProducer), and pre-existing
   * speakers would be silent for edge listeners.
   *
   * @returns Edge-local producer IDs paired with their owning userId. Empty
   * array when not an edge or origin returned no producers / fetch failed.
   */
  async fetchAndPipeExistingProducers(
    roomId: string,
    cluster: RoomMediaCluster,
  ): Promise<Array<{ producerId: string; userId: number }>> {
    if (!this.isEdgeRoom(roomId)) return [];

    // Coalesce concurrent joins so we only hit origin once per burst.
    // The shared promise also lets joins arriving mid-bootstrap return the
    // same edge-local IDs instead of seeing partial state.
    const existing = this.pendingBootstraps.get(roomId);
    if (existing) return existing;

    const promise = this.runBootstrap(roomId, cluster);
    this.pendingBootstraps.set(roomId, promise);
    try {
      return await promise;
    } finally {
      this.pendingBootstraps.delete(roomId);
    }
  }

  private async runBootstrap(
    roomId: string,
    cluster: RoomMediaCluster,
  ): Promise<Array<{ producerId: string; userId: number }>> {
    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) return [];

    const list = await this.fetchOriginProducers(originBaseUrl, roomId);
    if (!list || list.length === 0) return [];

    // Parallel pipe setup. Each requestPipeForProducer is independent and
    // already idempotent (cache + in-flight dedupe), so this safely no-ops
    // for producers piped by an earlier join.
    const results = await Promise.all(
      list.map(async (entry) => {
        const edgeId = await this.requestPipeForProducer(roomId, entry.producerId, cluster);
        return edgeId ? { producerId: edgeId, userId: entry.userId } : null;
      }),
    );

    const successful = results.filter(
      (r): r is { producerId: string; userId: number } => r !== null,
    );

    this.logger.info(
      { roomId, requested: list.length, piped: successful.length },
      "CascadeCoordinator: bootstrapped edge with existing origin producers",
    );

    return successful;
  }

  /**
   * GET origin's /internal/room/:id/producers to discover live source producers.
   */
  private async fetchOriginProducers(
    originBaseUrl: string,
    roomId: string,
  ): Promise<Array<{ producerId: string; userId: number; kind: string }> | null> {
    const url = `${originBaseUrl}/internal/room/${encodeURIComponent(roomId)}/producers`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PIPE_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "X-Internal-Key": config.INTERNAL_API_KEY || "",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            { roomId, status: response.status },
            "CascadeCoordinator: origin producers fetch failed",
          );
          return null;
        }

        const body = (await response.json()) as {
          status: string;
          producers: Array<{ producerId: string; userId: number; kind: string }>;
        };
        return body.producers ?? [];
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.error({ err, roomId }, "CascadeCoordinator: origin producers fetch error");
      return null;
    }
  }

  // ─── Participant Discovery (B-1 Stage 2j) ──────────────────────

  /**
   * Fetch participants currently connected to origin so an edge user's join
   * response includes the full room (not just same-region sockets).
   *
   * Returns null on any error; caller falls back to the local-only list so
   * the edge still works in degraded mode if origin is briefly unreachable.
   */
  async fetchOriginParticipants(
    roomId: string,
  ): Promise<Array<{
    id: number;
    name: string;
    signature: string;
    avatar: string;
    frame: string;
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
            frame: string;
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

  // ─── Room Snapshot (B-1 Stage 2k) ──────────────────────────────

  /**
   * Fetch origin's per-room Redis state (seats, locked seats, music player).
   * Each region has its own Redis, so this state is invisible to edges
   * locally — without this, cross-region users see empty seat occupancy
   * and no music state for rooms hosted in other regions.
   */
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

  /**
   * Handle a relayed audio:newProducer event on an edge instance.
   * Requests a new pipe from the origin for the newly added producer
   * so edge listeners can hear speakers who joined after the edge was set up.
   *
   * @returns The edge's LOCAL producer ID so the relay handler can rewrite
   * the broadcast payload — listeners consume against local IDs, not origin's.
   * Returns null when this isn't an edge or pipe setup failed.
   */
  /**
   * Handle a relayed audio:producerClosed event on an edge instance.
   * Closes the local edge-side producer + its PlainTransport so listener
   * consumers fire `producerclose` (existing handler in roomMediaCluster)
   * and the UDP port is freed.
   *
   * @returns The edge's LOCAL producer ID so the relay handler can rewrite
   * the broadcast payload — frontend listeners may key off it. Returns null
   * if no pipe was tracked (already closed, or producer never reached us).
   */
  async handleRemoteProducerClosed(roomId: string, producerId: string): Promise<string | null> {
    if (!this.isEdgeRoom(roomId)) return null;

    const entry = this.pipedProducers.get(roomId)?.get(producerId);
    if (!entry) {
      this.logger.debug(
        { roomId, producerId },
        "CascadeCoordinator: remote producer closed but no local pipe tracked",
      );
      return null;
    }

    const cluster = this.roomManager.getRoom(roomId);
    if (cluster) {
      const edgeProducer = cluster.getProducer(entry.edgeProducerId);
      if (edgeProducer && !edgeProducer.closed) {
        edgeProducer.close();
      }
    }

    if (!entry.transport.closed) {
      entry.transport.close();
    }

    // The producer's transportclose listener already removes the cache
    // entry; the explicit delete here covers the case where neither the
    // producer nor transport object emit (e.g., already-closed cluster).
    this.pipedProducers.get(roomId)?.delete(producerId);

    this.logger.info(
      { roomId, sourceProducerId: producerId, edgeProducerId: entry.edgeProducerId },
      "CascadeCoordinator: remote producer closed — edge pipe torn down",
    );

    return entry.edgeProducerId;
  }

  async handleRemoteNewProducer(roomId: string, producerId: string): Promise<string | null> {
    if (!this.isEdgeRoom(roomId)) return null;

    const cluster = this.roomManager.getRoom(roomId);
    if (!cluster?.router) {
      this.logger.warn({ roomId, producerId }, "CascadeCoordinator: no local cluster for remote producer");
      return null;
    }

    const edgeProducerId = await this.requestPipeForProducer(roomId, producerId, cluster);
    if (edgeProducerId) {
      this.logger.info(
        { roomId, sourceProducerId: producerId, edgeProducerId },
        "CascadeCoordinator: piped remote producer to edge",
      );
    }
    return edgeProducerId;
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
    edgeIp: string,
    edgePort: number,
    edgeRtpCapabilities: import("mediasoup").types.RtpCapabilities,
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
          body: JSON.stringify({ roomId, producerId, edgeIp, edgePort, edgeRtpCapabilities }),
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
   * Notify origin that this edge has registered for a room.
   * Origin registers us as a remote instance for its relay.
   */
  private async notifyOriginEdgeRegistered(
    originBaseUrl: string,
    roomId: string,
  ): Promise<void> {
    const url = `${originBaseUrl}/internal/cascade/relay`;
    // Reachability URL — must use PUBLIC_IP, not selfId (which is now an
    // EC2 instance-id like "i-0762744f24afb40ff" and would not resolve).
    const selfBaseUrl = `http://${config.PUBLIC_IP}:${config.PORT}`;

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

  // ─── Reverse pipe (edge speaker → origin) ─────────────────────

  /**
   * Edge-side: open a reverse pipe so origin receives the audio of a speaker
   * who produced on this edge. Without this, listeners on origin (and on
   * other edges) hear silence whenever NLB stickiness lands a speaker on an
   * edge instead of the origin.
   *
   * Idempotent per (roomId, edgeProducer.id) — second calls return the cached
   * originProducerId. Returns null on failure; callers should fall back to
   * "edge-local listeners only" rather than failing the produce.
   */
  async setupReversePipe(
    roomId: string,
    edgeProducer: import("mediasoup").types.Producer,
    cluster: RoomMediaCluster,
    userId: number,
  ): Promise<{ originProducerId: string } | null> {
    const cached = this.reversedProducers.get(roomId)?.get(edgeProducer.id);
    if (cached) {
      // originProducerId == null means a previous call cached the offer-side
      // state but never reached finalize (still in flight, or partial failure
      // not yet cleaned up). Don't start a duplicate setup against the same
      // local producer — let the caller treat this as a no-op.
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
      // Phase 1: edge creates outbound listener so we have a concrete address
      // to send to origin.
      outbound = await this.pipeManager.createReverseOutboundTransport(router, roomId);

      // Use PUBLIC_IP so origin can reach us across the public network —
      // tuple.localAddress is 0.0.0.0.
      const edgePublicIp = config.PUBLIC_IP || outbound.ip;

      // Phase 2: origin creates inbound transport, connects to us, returns its
      // listen address + router caps.
      const offerResponse = await this.requestReverseOffer(
        originBaseUrl,
        roomId,
        edgeProducer.id,
        edgePublicIp,
        outbound.port,
      );
      if (!offerResponse) {
        outbound.transport.close();
        return null;
      }

      // Cache the offer-side state immediately so a failure between offer and
      // finalize still has a recoverable cleanup path: closeReversePipe will
      // send the transportId to origin which can close the pre-finalize
      // (pending) transport.
      let perRoom = this.reversedProducers.get(roomId);
      if (!perRoom) {
        perRoom = new Map();
        this.reversedProducers.set(roomId, perRoom);
      }
      perRoom.set(edgeProducer.id, {
        outboundTransport: outbound.transport,
        originTransportId: offerResponse.transportId,
        originProducerId: null,
      });

      // Phase 3: edge connects + consumes its local producer with origin's
      // rtpCapabilities so the consumer's rtpParameters match what origin
      // can decode.
      const consumeResult = await this.pipeManager.connectReverseTransport(
        outbound.transport,
        { ip: offerResponse.ip, port: offerResponse.port },
        edgeProducer.id,
        offerResponse.rtpCapabilities,
        roomId,
      );

      // Phase 4: origin produces with the consumer's rtpParameters,
      // registers the producer with its cluster, and broadcasts
      // audio:newProducer. Returns origin's local producer id.
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
        // Trigger cleanup via the close path so origin closes its pending
        // transport and we drop the cache entry.
        await this.closeReversePipe(roomId, edgeProducer.id);
        metrics.reversePipeSetup.inc({ result: "failure" });
        return null;
      }

      // Update the cache with origin's producerId.
      const entry = perRoom.get(edgeProducer.id);
      if (entry) {
        entry.originProducerId = finalizeResponse.originProducerId;
      }

      // If our local outbound transport closes (e.g. mediasoup teardown,
      // room close) drop the cache entry so future cleanup attempts no-op.
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
      // Drop any partial cache entry left from the offer phase.
      this.reversedProducers.get(roomId)?.delete(edgeProducer.id);
      metrics.reversePipeSetup.inc({ result: "failure" });
      return null;
    }
  }

  /**
   * Edge-side cleanup: tell origin to close its inbound transport for this
   * producer (which closes the corresponding origin-side producer and
   * cascades audio:producerClosed to listeners).
   */
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

    try {
      await fetch(`${originBaseUrl}/internal/pipe/reverse-close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.INTERNAL_API_KEY || "",
        },
        // transportId lets origin clean up partial setups where finalize
        // never reached it (only offer succeeded). It's always known after
        // the offer response.
        body: JSON.stringify({
          roomId,
          edgeProducerId,
          transportId: entry.originTransportId,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.logger.warn(
        { err, roomId, edgeProducerId },
        "closeReversePipe: notify origin failed (origin will close on its own when its transport times out)",
      );
    }
  }

  /**
   * Cross-region attach: query origin's /internal/health to learn its real
   * instance-id. Same-region edges already have it from the Redis CAS claim;
   * cross-region only knows hosting_ip from Laravel, not instance-id.
   */
  private async fetchOriginInstanceId(
    originBaseUrl: string,
  ): Promise<string | null> {
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
