/**
 * EdgePipeLifecycle — owns the edge-side pipe idempotency cache and all
 * methods that create, reuse, bootstrap, and clean up pipes from edge to origin.
 *
 * Extracted from CascadeCoordinator so this cohesive chunk of state (three Maps)
 * and its operations live in one place. CascadeCoordinator delegates to this class
 * for every pipe-related action; it holds no pipe-specific Maps of its own.
 */
import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import type { PipeManager, PlainTransportInfo } from "@src/domains/media/pipe-manager.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { PipeOfferResponse } from "./types.js";
import { OriginSnapshot } from "./origin-snapshot.js";

const PIPE_REQUEST_TIMEOUT_MS = 10_000;

export class EdgePipeLifecycle {
  /**
   * Idempotency cache: roomId → (originProducerId → { edgeProducerId, transport }).
   *
   * Prevents duplicate pipes when multiple listeners join for the same speaker.
   */
  private readonly pipedProducers = new Map<
    string,
    Map<string, { edgeProducerId: string; transport: import("mediasoup").types.PlainTransport }>
  >();

  /**
   * In-flight pipe creations keyed by `${roomId}:${producerId}` so concurrent
   * callers requesting the same producer share a single setup attempt.
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

  private readonly originSnapshot: OriginSnapshot;

  constructor(
    private readonly pipeManager: PipeManager,
    private readonly roomManager: RoomManager,
    /** Shared reference from CascadeCoordinator — read-only here. */
    private readonly originUrls: ReadonlyMap<string, string>,
    private readonly logger: Logger,
  ) {
    this.originSnapshot = new OriginSnapshot(logger);
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Request a pipe from the origin for a specific producer.
   * Idempotent: returns the cached edge-local producer id if already piped.
   * Coalesces concurrent calls for the same producer to one setup attempt.
   */
  async requestPipeForProducer(
    roomId: string,
    producerId: string,
    cluster: RoomMediaCluster,
  ): Promise<string | null> {
    const existing = this.pipedProducers.get(roomId)?.get(producerId);
    if (existing) {
      return existing.edgeProducerId;
    }

    const inflightKey = `${roomId}:${producerId}`;
    const pending = this.pendingPipes.get(inflightKey);
    if (pending) {
      return pending;
    }

    const promise = this.doRequestPipeForProducer(roomId, producerId, cluster);
    this.pendingPipes.set(inflightKey, promise);
    try {
      return await promise;
    } finally {
      this.pendingPipes.delete(inflightKey);
    }
  }

  /**
   * Fetch origin's full producer list and pipe each one to the edge.
   * Coalesces concurrent joins so origin is only hit once per burst.
   */
  async fetchAndPipeExistingProducers(
    roomId: string,
    cluster: RoomMediaCluster,
  ): Promise<Array<{ producerId: string; userId: number }>> {
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

  /**
   * Handle a relayed audio:producerClosed event. Closes the local pipe and
   * returns the edge-local producer id (for relay payload rewriting).
   */
  async handleRemoteProducerClosed(roomId: string, producerId: string): Promise<string | null> {
    const entry = this.pipedProducers.get(roomId)?.get(producerId);
    if (!entry) {
      this.logger.debug(
        { roomId, producerId },
        "EdgePipeLifecycle: remote producer closed but no local pipe tracked",
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

    this.pipedProducers.get(roomId)?.delete(producerId);

    this.logger.info(
      { roomId, sourceProducerId: producerId, edgeProducerId: entry.edgeProducerId },
      "EdgePipeLifecycle: remote producer closed — edge pipe torn down",
    );

    return entry.edgeProducerId;
  }

  /**
   * Handle a relayed audio:newProducer event. Pipes the new producer to the edge
   * and returns the edge-local producer id.
   */
  async handleRemoteNewProducer(roomId: string, producerId: string): Promise<string | null> {
    const cluster = this.roomManager.getRoom(roomId);
    if (!cluster?.router) {
      this.logger.warn(
        { roomId, producerId },
        "EdgePipeLifecycle: no local cluster for remote producer",
      );
      return null;
    }

    const edgeProducerId = await this.requestPipeForProducer(roomId, producerId, cluster);
    if (edgeProducerId) {
      this.logger.info(
        { roomId, sourceProducerId: producerId, edgeProducerId },
        "EdgePipeLifecycle: piped remote producer to edge",
      );
    }
    return edgeProducerId;
  }

  /**
   * Notify origin that this edge is registering for a room.
   * Called from CascadeCoordinator.attachToOrigin — public because attachment
   * lives on the coordinator, not the lifecycle class.
   */
  async notifyOriginEdgeRegistered(originBaseUrl: string, roomId: string): Promise<void> {
    const url = `${originBaseUrl}/internal/cascade/relay`;
    const selfBaseUrl = `http://${config.PUBLIC_IP}:${config.PORT}`;
    const selfId = config.INSTANCE_ID;

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
          edgeInstanceId: selfId,
          edgeBaseUrl: selfBaseUrl,
          edgeRegion: config.AWS_REGION,
        },
        sourceInstanceId: selfId,
      }),
      // realtime-20: bound this internal POST. On the snapshot-miss recovery's
      // re-attach (Case B: ≤90s after origin death, owner CAS not yet expired so
      // `handleSameRegionEdge` re-reads the still-stale `:origin` info and points
      // back at the dead host), an UNTIMED fetch to that dead IP would hang far
      // past the client's 10s `room:join` ack. 3s caps it so the degrade stays
      // bounded; the caller (`attachToOrigin`) already try/catches this.
      signal: AbortSignal.timeout(3_000),
    });
  }

  /**
   * Drain in-flight setups for a room, fire-and-forget notify origin, then
   * clear all pipe Maps for the room. Called from CascadeCoordinator.cleanup.
   */
  async cleanupRoom(roomId: string): Promise<void> {
    const originBaseUrl = this.originUrls.get(roomId);
    if (originBaseUrl) {
      this.notifyOriginPipeClose(originBaseUrl, roomId).catch((err) =>
        this.logger.error(
          { err, roomId },
          "EdgePipeLifecycle: failed to notify origin of pipe close",
        ),
      );
    }

    // F-43: drain in-flight setups before clearing state so a late-completing
    // setup doesn't register against a freshly-closed cluster (ghost resource).
    const inflight: Promise<unknown>[] = [];
    for (const [key, p] of this.pendingPipes) {
      if (key.startsWith(`${roomId}:`)) inflight.push(p);
    }
    const bootstrap = this.pendingBootstraps.get(roomId);
    if (bootstrap) inflight.push(bootstrap);
    if (inflight.length > 0) {
      await Promise.allSettled(inflight);
    }

    this.pipedProducers.delete(roomId);
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private async doRequestPipeForProducer(
    roomId: string,
    producerId: string,
    cluster: RoomMediaCluster,
  ): Promise<string | null> {
    const router = cluster.router;
    if (!router) {
      this.logger.error({ roomId }, "EdgePipeLifecycle: cluster has no source router");
      return null;
    }

    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) {
      this.logger.error({ roomId }, "EdgePipeLifecycle: no origin URL for room");
      return null;
    }

    let edgeListener: Awaited<ReturnType<PipeManager["createEdgeListener"]>> | null = null;
    try {
      edgeListener = await this.pipeManager.createEdgeListener(router, roomId);

      const edgePublicIp = config.PUBLIC_IP || edgeListener.ip;

      const offerResponse = await this.requestPipeOffer(
        originBaseUrl,
        roomId,
        producerId,
        edgePublicIp,
        edgeListener.port,
        router.rtpCapabilities,
      );

      if (!offerResponse) {
        edgeListener.transport.close();
        return null;
      }

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

      await cluster.registerProducer(producer);

      let roomMap = this.pipedProducers.get(roomId);
      if (!roomMap) {
        roomMap = new Map();
        this.pipedProducers.set(roomId, roomMap);
      }
      roomMap.set(producerId, { edgeProducerId: producer.id, transport: edgeListener.transport });

      this.reactOnPipeClose(producer, roomId, producerId);

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
        "EdgePipeLifecycle: edge pipe established",
      );

      return producer.id;
    } catch (err) {
      this.logger.error(
        { err, roomId, producerId },
        "EdgePipeLifecycle: failed to set up edge pipe",
      );
      if (edgeListener && !edgeListener.transport.closed) {
        edgeListener.transport.close();
      }
      return null;
    }
  }

  private async runBootstrap(
    roomId: string,
    cluster: RoomMediaCluster,
  ): Promise<Array<{ producerId: string; userId: number }>> {
    const originBaseUrl = this.originUrls.get(roomId);
    if (!originBaseUrl) return [];

    const list = await this.originSnapshot.fetchOriginProducers(originBaseUrl, roomId);
    if (!list || list.length === 0) return [];

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
      "EdgePipeLifecycle: bootstrapped edge with existing origin producers",
    );

    return successful;
  }

  /** Drop the cache entry when origin's producer (and therefore our pipe) closes. */
  private reactOnPipeClose(
    producer: import("mediasoup").types.Producer,
    roomId: string,
    producerId: string,
  ): void {
    producer.on("transportclose", () => {
      this.pipedProducers.get(roomId)?.delete(producerId);
    });
  }

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
            "EdgePipeLifecycle: pipe offer request failed",
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
        "EdgePipeLifecycle: pipe offer request error",
      );
      return null;
    }
  }

  private async notifyOriginPipeClose(originBaseUrl: string, roomId: string): Promise<void> {
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
          edgeInstanceId: config.INSTANCE_ID,
        }),
      });
    } catch (err) {
      this.logger.warn({ err, roomId }, "EdgePipeLifecycle: failed to notify origin pipe close");
    }
  }
}
