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

  /** Maps transportId → which RouterManager owns it */
  private readonly transportOwnership = new Map<string, RouterManager>();

  /** Tracks sourceProducerIds for piping to new distribution routers */
  private readonly sourceProducerIds: Set<string> = new Set();

  /** Maps consumerId → sourceProducerId (for active speaker forwarding) */
  private readonly consumerSourceMap = new Map<string, string>();

  /** Currently active source producer IDs (top N speakers) */
  private activeSpeakerProducerIds = new Set<string>();

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
  get audioObserver(): mediasoup.types.ActiveSpeakerObserver | null {
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
      this.transportOwnership.set(transport.id, this.sourceRouter);
      return transport;
    }

    // Listeners consume on a distribution router
    const distRouter = await this.getOrCreateDistributionRouter();
    const transport = await distRouter.routerManager.createWebRtcTransport(
      false,
    );
    this.transportOwnership.set(transport.id, distRouter.routerManager);
    distRouter.listenerCount++;

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
    // Fast path: check ownership map
    const owner = this.transportOwnership.get(transportId);
    if (owner) return owner.getTransport(transportId);

    // Fallback: search all routers
    const fromSource = this.sourceRouter?.getTransport(transportId);
    if (fromSource) return fromSource;

    for (const dist of this.distributionRouters) {
      const t = dist.routerManager.getTransport(transportId);
      if (t) return t;
    }
    return undefined;
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

  // ─────────────────────────────────────────────────────────────────
  // Consumer Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Check if a listener can consume the given source producer.
   * Checks against the first distribution router's piped producer.
   */
  canConsume(
    sourceProducerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ): boolean {
    // If no distribution routers, listeners haven't joined yet
    if (this.distributionRouters.length === 0) return false;

    const dist = this.distributionRouters[0];
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
    this.consumerSourceMap.set(consumer.id, sourceProducerId);
    const cleanup = () => {
      this.consumerSourceMap.delete(consumer.id);
      if (!consumer.closed) consumer.close();
    };
    consumer.on("transportclose", cleanup);
    consumer.on("producerclose", cleanup);

    dist.routerManager.registerConsumer(consumer);

    // Auto-pause if source producer is NOT an active speaker
    // (consumers start paused anyway, but we also prevent resume
    // from being effective until the speaker becomes active)

    return consumer;
  }

  /** Find a consumer across all distribution routers */
  getConsumer(consumerId: string): mediasoup.types.Consumer | undefined {
    for (const dist of this.distributionRouters) {
      const c = dist.routerManager.getConsumer(consumerId);
      if (c) return c;
    }
    return undefined;
  }

  /** Register an externally-created consumer (for compatibility) */
  registerConsumer(consumer: mediasoup.types.Consumer): void {
    // Find the distribution router that owns this consumer's transport
    for (const dist of this.distributionRouters) {
      dist.routerManager.registerConsumer(consumer);
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Active Speaker Forwarding
  // ─────────────────────────────────────────────────────────────────

  /**
   * Update the set of active speakers and pause/resume consumers accordingly.
   * Called by ActiveSpeakerDetector when the active speaker set changes.
   *
   * Consumers for active speakers are RESUMED (if not already).
   * Consumers for inactive speakers are PAUSED (saving CPU).
   */
  async updateActiveSpeakers(
    activeProducerIds: string[],
  ): Promise<void> {
    const newActiveSet = new Set(activeProducerIds);
    const oldActiveSet = this.activeSpeakerProducerIds;
    this.activeSpeakerProducerIds = newActiveSet;

    // Find consumers that need state changes
    const pausePromises: Promise<void>[] = [];
    const resumePromises: Promise<void>[] = [];

    for (const [consumerId, sourceProducerId] of this.consumerSourceMap) {
      const wasActive = oldActiveSet.has(sourceProducerId);
      const isActive = newActiveSet.has(sourceProducerId);

      if (wasActive && !isActive) {
        // Speaker became inactive → pause consumer
        const consumer = this.getConsumer(consumerId);
        if (consumer && !consumer.paused) {
          pausePromises.push(consumer.pause());
        }
      } else if (!wasActive && isActive) {
        // Speaker became active → resume consumer
        const consumer = this.getConsumer(consumerId);
        if (consumer && consumer.paused) {
          resumePromises.push(consumer.resume());
        }
      }
    }

    await Promise.all([...pausePromises, ...resumePromises]);

    if (pausePromises.length > 0 || resumePromises.length > 0) {
      this.logger.debug(
        {
          activeSpeakers: activeProducerIds.length,
          paused: pausePromises.length,
          resumed: resumePromises.length,
        },
        "RoomMediaCluster: active speaker consumers updated",
      );
    }
  }

  /** Check if a source producer is currently an active speaker */
  isActiveSpeaker(sourceProducerId: string): boolean {
    // If no active speakers tracked yet (room just started), all are active
    if (this.activeSpeakerProducerIds.size === 0) return true;
    return this.activeSpeakerProducerIds.has(sourceProducerId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Distribution Router Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the least loaded distribution router, or create a new one
   * if all are at capacity.
   */
  private async getOrCreateDistributionRouter(): Promise<DistributionRouter> {
    // Find an existing distribution router with capacity
    for (const dist of this.distributionRouters) {
      if (
        dist.listenerCount < config.MAX_LISTENERS_PER_DISTRIBUTION_ROUTER
      ) {
        return dist;
      }
    }

    // All at capacity (or none exist) — create a new one
    return this.createDistributionRouter();
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

    // Pipe all existing source producers to this new distribution router
    for (const sourceProducerId of this.sourceProducerIds) {
      await this.pipeProducerToDistributionRouter(sourceProducerId, dist);
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
    if (!this.sourceRouter?.router || !dist.routerManager.router) {
      this.logger.warn("Cannot pipe: routers not ready");
      return;
    }

    try {
      const { pipeProducer } = await this.sourceRouter.router.pipeToRouter({
        producerId: sourceProducerId,
        router: dist.routerManager.router,
      });

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
    } catch (error) {
      this.logger.error(
        { error, sourceProducerId },
        "RoomMediaCluster: failed to pipe producer",
      );
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
    this.consumerSourceMap.clear();
    this.activeSpeakerProducerIds.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  /** Find which distribution router owns a given transport */
  private findDistributionRouterForTransport(
    transportId: string,
  ): DistributionRouter | undefined {
    for (const dist of this.distributionRouters) {
      if (dist.routerManager.getTransport(transportId)) {
        return dist;
      }
    }
    return undefined;
  }
}
