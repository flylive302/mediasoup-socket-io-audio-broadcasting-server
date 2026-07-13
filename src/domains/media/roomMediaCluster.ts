/**
 * RoomMediaCluster — Multi-router room media management
 *
 * Uses mediasoup's pipeToRouter() to distribute listeners across
 * multiple CPU cores for unlimited listeners per room.
 *
 * Architecture:
 *   Source Router (1) — speakers produce here
 *   Distribution Routers (N) — listeners consume here, each on a separate worker
 *   Pipe Transports — bridge producers from source to distribution routers
 */
import * as mediasoup from "mediasoup";
import type { Logger } from "@src/infrastructure/logger.js";
import type { WorkerManager } from "@src/infrastructure/worker.manager.js";
import { config } from "@src/config/index.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { retryAsync } from "@src/shared/retry.js";
import { RouterManager } from "./routerManager.js";

interface DistributionRouter {
  routerManager: RouterManager;
  listenerCount: number;
  /** Maps sourceProducerId → pipedProducerId on this distribution router */
  pipedProducerMap: Map<string, string>;
}

export class RoomMediaCluster {
  /** Source router where speakers produce */
  private sourceRouter: RouterManager | null = null;

  /** Distribution routers where listeners consume */
  private readonly distributionRouters: DistributionRouter[] = [];

  /**
   * F-29: in-flight distribution-router creation. A burst of N concurrent
   * listeners would otherwise each see "no router with capacity" and spawn
   * its own router (N routers instead of 1, exhausting workers). Concurrent
   * callers needing a new router await this single promise instead.
   */
  private pendingDistRouter: Promise<DistributionRouter> | null = null;

  /** Maps transportId → which DistributionRouter owns it (PERF-LOW-001: O(1) lookup) */
  private readonly transportOwnership = new Map<string, DistributionRouter>();

  /** Maps consumerId → DistributionRouter for O(1) lookup (PERF-MED-001) */
  private readonly consumerOwnership = new Map<string, DistributionRouter>();

  /** Tracks sourceProducerIds for piping to new distribution routers */
  private readonly sourceProducerIds: Set<string> = new Set();



  /** ActiveSpeakerDetector reference for cleanup */
  private activeSpeakerDetector: { stop(): void } | null = null;

  constructor(
    private readonly workerManager: WorkerManager,
    private readonly logger: Logger,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // Public Accessors (RouterManager-compatible interface)
  // ─────────────────────────────────────────────────────────────────

  /** Source router — used for rtpCapabilities and speaker operations */
  get router(): mediasoup.types.Router | null {
    return this.sourceRouter?.router ?? null;
  }

  /** Audio observer from source router */
  get audioObserver(): mediasoup.types.AudioLevelObserver | null {
    return this.sourceRouter?.audioObserver ?? null;
  }

  /** Source router's worker (primary worker for this room) */
  get worker(): mediasoup.types.Worker {
    if (!this.sourceRouter) throw new Error("Cluster not initialized");
    return this.sourceRouter.worker;
  }

  /** All worker PIDs used by this cluster (source + distribution) */
  getWorkerPids(): number[] {
    const pids: number[] = [];
    if (this.sourceRouter) pids.push(this.sourceRouter.worker.pid);
    for (const dist of this.distributionRouters) {
      pids.push(dist.routerManager.worker.pid);
    }
    return pids;
  }

  /** Total listener count across all distribution routers */
  getListenerCount(): number {
    return this.distributionRouters.reduce((sum, d) => sum + d.listenerCount, 0);
  }

  // ─────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────

  /** Initialize the source router on the least-loaded worker */
  async initialize(): Promise<void> {
    const worker = this.workerManager.getLeastLoadedWorker();
    const webRtcServer = this.workerManager.getWebRtcServer(worker);

    this.sourceRouter = new RouterManager(worker, this.logger, webRtcServer);
    await this.sourceRouter.initialize();
    this.workerManager.incrementRouterCount(worker);

    this.logger.info(
      { workerPid: worker.pid },
      "RoomMediaCluster: source router initialized",
    );
  }

  /** Store detector reference for cleanup on close */
  setActiveSpeakerDetector(detector: { stop(): void }): void {
    this.activeSpeakerDetector = detector;
  }

  // ─────────────────────────────────────────────────────────────────
  // Transport Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Create a WebRTC transport.
   * - Speakers (isProducer=true) → source router
   * - Listeners (isProducer=false) → least-loaded distribution router
   */
  async createWebRtcTransport(
    isProducer: boolean,
  ): Promise<mediasoup.types.WebRtcTransport> {
    if (!this.sourceRouter) throw new Error("Cluster not initialized");

    if (isProducer) {
      // Speakers always produce on the source router
      const transport = await this.sourceRouter.createWebRtcTransport(true);
      // Producer transports don't belong to a DistributionRouter — skip ownership map
      return transport;
    }

    // Listeners consume on a distribution router. getOrCreateDistributionRouter
    // has ALREADY reserved a listener slot (incremented listenerCount) for us
    // — F-30: the slot must be reserved before the await, otherwise concurrent
    // callers all pass the capacity check against the same pre-increment value
    // and over-fill the router. Release the reservation if transport creation
    // fails (the close-observer handles the normal-lifecycle decrement).
    const distRouter = await this.getOrCreateDistributionRouter();
    let transport: mediasoup.types.WebRtcTransport;
    try {
      transport = await distRouter.routerManager.createWebRtcTransport(false);
    } catch (err) {
      distRouter.listenerCount = Math.max(0, distRouter.listenerCount - 1);
      throw err;
    }
    this.transportOwnership.set(transport.id, distRouter);

    // ARCH-001 FIX: Decrement listener count when transport closes
    transport.observer.on("close", () => {
      distRouter.listenerCount = Math.max(0, distRouter.listenerCount - 1);
      this.transportOwnership.delete(transport.id);
      this.logger.debug(
        { transportId: transport.id, listenerCount: distRouter.listenerCount },
        "RoomMediaCluster: listener transport closed, count decremented",
      );
    });

    this.logger.debug(
      {
        transportId: transport.id,
        distRouterIndex: this.distributionRouters.indexOf(distRouter),
        listenerCount: distRouter.listenerCount,
      },
      "RoomMediaCluster: listener transport created on distribution router",
    );

    return transport;
  }

  /** Find a transport across all routers */
  getTransport(
    transportId: string,
  ): mediasoup.types.WebRtcTransport | undefined {
    // Fast path: check distribution router ownership map (PERF-LOW-001)
    const dist = this.transportOwnership.get(transportId);
    if (dist) return dist.routerManager.getTransport(transportId);

    // Fallback: check source router (producer transports)
    return this.sourceRouter?.getTransport(transportId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Producer Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Register a producer on the source router and pipe it to all
   * existing distribution routers.
   */
  async registerProducer(producer: mediasoup.types.Producer): Promise<void> {
    if (!this.sourceRouter) throw new Error("Cluster not initialized");

    this.sourceRouter.registerProducer(producer);
    this.sourceProducerIds.add(producer.id);

    // Clean up tracking when producer closes
    producer.on("transportclose", () => {
      this.sourceProducerIds.delete(producer.id);
    });

    // Pipe to all existing distribution routers
    await this.pipeProducerToAllDistributionRouters(producer.id);
  }

  /** Get a producer from the source router */
  getProducer(producerId: string): mediasoup.types.Producer | undefined {
    return this.sourceRouter?.getProducer(producerId);
  }

  /**
   * realtime-17b: count of live, RESUMED audio source producers — i.e. speakers
   * actually emitting RTP right now (paused = manager-muted = no RTP). This is the
   * exact set the broadcast SpeakerMixer feeds FFmpeg, so it's the authoritative
   * "is anyone broadcastable?" signal used to gate the interactive→broadcast flip:
   * flipping a Room to broadcast with zero speakers means clients fetch an HLS
   * manifest that can never exist (no FFmpeg) → a permanent master.m3u8 404.
   *
   * On the origin this includes cascade reverse-piped edge speakers (registered
   * locally via /internal/pipe/reverse-finalize), so it reflects the whole Room.
   */
  getResumedAudioProducerCount(): number {
    if (!this.sourceRouter) return 0;
    let count = 0;
    for (const id of this.sourceProducerIds) {
      const p = this.sourceRouter.getProducer(id);
      if (p && !p.closed && p.kind === "audio" && !p.paused) count++;
    }
    return count;
  }

  /**
   * List all live source producers with their owning userId.
   * Used by /internal/room/:id/producers so an attaching edge can fetch the
   * speaker set on join and pipe each before serving listeners.
   */
  getSourceProducers(): Array<{
    producerId: string;
    userId: number;
    kind: mediasoup.types.MediaKind;
    source: string;
  }> {
    if (!this.sourceRouter) return [];
    const out: Array<{
      producerId: string;
      userId: number;
      kind: mediasoup.types.MediaKind;
      source: string;
    }> = [];
    for (const id of this.sourceProducerIds) {
      const p = this.sourceRouter.getProducer(id);
      if (p && !p.closed) {
        out.push({
          producerId: p.id,
          userId: p.appData.userId as number,
          kind: p.kind,
          // dj-talk-over/01: coerce to the two-value contract. appData.source
          // is ALSO used pre-existing by the reverse-pipe path as a marker
          // ("reverse-pipe", unrelated to mic/music) — anything that isn't
          // explicitly "music" (undefined, "reverse-pipe", future markers)
          // must read as "mic", never leak a third value to callers.
          source: p.appData.source === "music" ? "music" : "mic",
        });
      }
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────
  // Consumer Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Check if a listener can consume the given source producer on the
   * distribution router that owns the listener's transport.
   *
   * Checking router[0] as a proxy (old ARCH-LOW-001b assumption: "all routers
   * have identical piped sets") gave false positives exactly when a pipe to
   * ONE router had failed — canConsume said yes, consume() then threw
   * "not piped" for that router's listeners only (asymmetric audibility).
   */
  canConsume(
    transportId: string,
    sourceProducerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ): boolean {
    const dist = this.findDistributionRouterForTransport(transportId);
    if (!dist) return false;

    const pipedId = dist.pipedProducerMap.get(sourceProducerId);
    if (!pipedId || !dist.routerManager.router) return false;

    return dist.routerManager.router.canConsume({
      producerId: pipedId,
      rtpCapabilities,
    });
  }

  /**
   * Create a consumer on a distribution router for the given source producer.
   * Resolves the piped producer ID and creates the consumer on the correct router.
   */
  async consume(
    transportId: string,
    sourceProducerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ): Promise<mediasoup.types.Consumer> {
    // Find which distribution router owns this transport
    const dist = this.findDistributionRouterForTransport(transportId);
    if (!dist) {
      throw new Error(
        `Transport ${transportId} not found on any distribution router`,
      );
    }

    // Resolve the piped producer ID on this distribution router
    const pipedProducerId = dist.pipedProducerMap.get(sourceProducerId);
    if (!pipedProducerId) {
      throw new Error(
        `Producer ${sourceProducerId} not piped to distribution router`,
      );
    }

    const transport = dist.routerManager.getTransport(transportId);
    if (!transport) {
      throw new Error(`Transport ${transportId} not found`);
    }

    // Create consumer using the piped producer
    const consumer = await transport.consume({
      producerId: pipedProducerId,
      rtpCapabilities,
      paused: true,
      appData: { sourceProducerId },
    });

    // CQ-002 FIX: Combined cleanup for both close events (was 4 listeners, now 2)
    // PERF-MED-001: Track consumer ownership for O(1) lookup
    this.consumerOwnership.set(consumer.id, dist);
    const cleanup = () => {
      this.consumerOwnership.delete(consumer.id);
      if (!consumer.closed) consumer.close();
    };
    consumer.on("transportclose", cleanup);
    consumer.on("producerclose", cleanup);

    dist.routerManager.registerConsumer(consumer);

    return consumer;
  }

  /** Find a consumer across all distribution routers (PERF-MED-001: O(1) via ownership map) */
  getConsumer(consumerId: string): mediasoup.types.Consumer | undefined {
    // Fast path: check ownership map
    const dist = this.consumerOwnership.get(consumerId);
    if (dist) return dist.routerManager.getConsumer(consumerId);

    // Fallback: linear scan (for consumers created before ownership tracking)
    for (const d of this.distributionRouters) {
      const c = d.routerManager.getConsumer(consumerId);
      if (c) return c;
    }
    return undefined;
  }



  // ─────────────────────────────────────────────────────────────────
  // Distribution Router Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the least loaded distribution router, or create a new one
   * if all are at capacity.
   */
  private async getOrCreateDistributionRouter(): Promise<DistributionRouter> {
    // F-30: scan + reserve synchronously. There is NO await between the
    // capacity check and the increment, so the slot reservation is atomic
    // relative to other callers (JS is single-threaded). Caller must release
    // the slot if it fails to use it.
    for (const dist of this.distributionRouters) {
      if (dist.listenerCount < config.MAX_LISTENERS_PER_DISTRIBUTION_ROUTER) {
        dist.listenerCount++;
        return dist;
      }
    }

    // None with capacity — F-29: coalesce concurrent creation so a burst
    // creates ONE new router, not one per caller.
    if (!this.pendingDistRouter) {
      this.pendingDistRouter = this.createDistributionRouter().finally(() => {
        this.pendingDistRouter = null;
      });
    }
    const created = await this.pendingDistRouter;

    // The coalesced router may already be full if the burst exceeds one
    // router's capacity. Re-check + reserve synchronously; recurse (which
    // re-coalesces) to spin up another only when this one is genuinely full.
    if (created.listenerCount < config.MAX_LISTENERS_PER_DISTRIBUTION_ROUTER) {
      created.listenerCount++;
      return created;
    }
    return this.getOrCreateDistributionRouter();
  }

  /**
   * Create a new distribution router on a different worker than the source.
   * Pipes all existing source producers to the new router.
   */
  private async createDistributionRouter(): Promise<DistributionRouter> {
    if (!this.sourceRouter?.router) {
      throw new Error("Source router not initialized");
    }

    // Get a worker — preferably different from the source router's worker
    const worker = this.workerManager.getLeastLoadedWorker();
    const webRtcServer = this.workerManager.getWebRtcServer(worker);

    const routerManager = new RouterManager(worker, this.logger, webRtcServer);
    await routerManager.initialize();
    this.workerManager.incrementRouterCount(worker);

    const dist: DistributionRouter = {
      routerManager,
      listenerCount: 0,
      pipedProducerMap: new Map(),
    };

    // Pipe all existing source producers to this new distribution router.
    // All-or-nothing: a router missing even one speaker gives its listeners
    // a silently incomplete room, so on failure tear the router down and
    // rethrow — the joining listener fails loudly and retries.
    try {
      for (const sourceProducerId of this.sourceProducerIds) {
        await this.pipeProducerToDistributionRouter(sourceProducerId, dist);
      }
    } catch (err) {
      await routerManager.close();
      this.workerManager.decrementRouterCount(worker);
      throw err;
    }

    this.distributionRouters.push(dist);

    this.logger.info(
      {
        distIndex: this.distributionRouters.length - 1,
        workerPid: worker.pid,
        pipedProducers: this.sourceProducerIds.size,
      },
      "RoomMediaCluster: distribution router created",
    );

    return dist;
  }

  // ─────────────────────────────────────────────────────────────────
  // Pipe Transport Logic
  // ─────────────────────────────────────────────────────────────────

  /**
   * Pipe a source producer to all existing distribution routers.
   */
  private async pipeProducerToAllDistributionRouters(
    sourceProducerId: string,
  ): Promise<void> {
    const promises = this.distributionRouters.map((dist) =>
      this.pipeProducerToDistributionRouter(sourceProducerId, dist),
    );
    await Promise.all(promises);
  }

  /**
   * Pipe a single producer from source router to a distribution router.
   * Stores the mapping from sourceProducerId → pipedProducerId.
   */
  private async pipeProducerToDistributionRouter(
    sourceProducerId: string,
    dist: DistributionRouter,
  ): Promise<void> {
    const sourceRouter = this.sourceRouter?.router;
    const distRouter = dist.routerManager.router;
    if (!sourceRouter || !distRouter) {
      this.logger.warn("Cannot pipe: routers not ready");
      return;
    }

    try {
      // Transient pipe failures (worker churn, in-flight transport teardown)
      // must not leave a speaker permanently inaudible on this router — retry
      // before giving up (2026-07-10 audio review: asymmetric audibility).
      const { pipeProducer } = await retryAsync(() =>
        sourceRouter.pipeToRouter({
          producerId: sourceProducerId,
          router: distRouter,
        }),
      );

      if (pipeProducer) {
        dist.pipedProducerMap.set(sourceProducerId, pipeProducer.id);

        // Clean up mapping when piped producer closes
        const pipedProducerMap = dist.pipedProducerMap;
        pipeProducer.on("transportclose", () => {
          pipedProducerMap.delete(sourceProducerId);
        });

        this.logger.debug(
          {
            sourceProducerId,
            pipedProducerId: pipeProducer.id,
          },
          "RoomMediaCluster: producer piped to distribution router",
        );
      }
      metrics.distPipeSetup.inc({ result: "success" });
    } catch (err) {
      // Key MUST be `err` (not `error`) so Pino's Error serializer runs — otherwise
      // the Error serializes to `{}` and the real cause is lost (see the 2026-07-06
      // num-workers pipe bug: this exact failure was invisible for hours).
      this.logger.error(
        { err, sourceProducerId },
        "RoomMediaCluster: failed to pipe producer",
      );
      metrics.distPipeSetup.inc({ result: "failure" });
      // Rethrow: a producer missing from one distribution router means some
      // listeners silently can't hear this speaker while others can. Callers
      // treat pipe setup as all-or-nothing (close the producer / fail the
      // join) so the client retries instead of half-working.
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────

  /**
   * Close the entire cluster — source + all distribution routers.
   */
  async close(): Promise<void> {
    // Stop active speaker detector
    if (this.activeSpeakerDetector) {
      this.activeSpeakerDetector.stop();
      this.activeSpeakerDetector = null;
    }

    // Close all distribution routers
    for (const dist of this.distributionRouters) {
      try {
        await dist.routerManager.close();
        this.workerManager.decrementRouterCount(dist.routerManager.worker);
      } catch {
        // Worker may already be dead
      }
    }
    this.distributionRouters.length = 0;

    // Close source router
    if (this.sourceRouter) {
      try {
        await this.sourceRouter.close();
        this.workerManager.decrementRouterCount(this.sourceRouter.worker);
      } catch {
        // Worker may already be dead
      }
      this.sourceRouter = null;
    }

    this.transportOwnership.clear();
    this.sourceProducerIds.clear();
    this.consumerOwnership.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  /** Find which distribution router owns a given transport (PERF-LOW-001: O(1) via map) */
  private findDistributionRouterForTransport(
    transportId: string,
  ): DistributionRouter | undefined {
    return this.transportOwnership.get(transportId);
  }
}
