import type { Logger } from "@src/infrastructure/logger.js";
import type { PipeManager } from "@src/domains/media/pipe-manager.js";
import type { RoomMediaCluster } from "@src/domains/media/roomMediaCluster.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import type { RoomRegistry } from "@src/domains/room/room-registry.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { CascadeRelay } from "./cascade-relay.js";
import type { CascadeJoinResult, OriginParticipant, OriginRoomSnapshot } from "./types.js";
import { OriginSnapshot } from "./origin-snapshot.js";
import { CrossRegionJoin } from "./cross-region-join.js";
import { EdgePipeLifecycle } from "./edge-pipe-lifecycle.js";
import { ReversePipeLifecycle } from "./reverse-pipe-lifecycle.js";

export class CascadeCoordinator {
  private readonly crossRegionJoin: CrossRegionJoin;
  private readonly edgePipeLifecycle: EdgePipeLifecycle;
  private readonly reversePipeLifecycle: ReversePipeLifecycle;
  private readonly originSnapshot: OriginSnapshot;

  constructor(
    roomManager: RoomManager,
    private readonly pipeManager: PipeManager,
    roomRegistry: RoomRegistry,
    laravelClient: LaravelClient,
    private readonly cascadeRelay: CascadeRelay,
    private readonly logger: Logger,
  ) {
    this.originSnapshot = new OriginSnapshot(logger);
    this.crossRegionJoin = new CrossRegionJoin(roomRegistry, laravelClient, cascadeRelay, this.originSnapshot, logger);
    this.edgePipeLifecycle = new EdgePipeLifecycle(pipeManager, roomManager, this.crossRegionJoin.originUrls, logger);
    this.reversePipeLifecycle = new ReversePipeLifecycle(pipeManager, this.crossRegionJoin.originUrls, logger);
    this.crossRegionJoin.bindEdgePipeLifecycle(this.edgePipeLifecycle);
  }

  isEdgeRoom(roomId: string): boolean { return this.crossRegionJoin.isEdgeRoom(roomId); }

  async handleCrossRegionJoin(roomId: string): Promise<CascadeJoinResult> {
    return this.crossRegionJoin.handleCrossRegionJoin(roomId);
  }

  async handleSameRegionEdge(roomId: string, ownerInstanceId: string): Promise<CascadeJoinResult> {
    return this.crossRegionJoin.handleSameRegionEdge(roomId, ownerInstanceId);
  }

  async requestPipeForProducer(roomId: string, producerId: string, cluster: RoomMediaCluster): Promise<string | null> {
    return this.edgePipeLifecycle.requestPipeForProducer(roomId, producerId, cluster);
  }

  async fetchAndPipeExistingProducers(roomId: string, cluster: RoomMediaCluster): Promise<Array<{ producerId: string; userId: number }>> {
    if (!this.isEdgeRoom(roomId)) return [];
    return this.edgePipeLifecycle.fetchAndPipeExistingProducers(roomId, cluster);
  }

  async fetchOriginParticipants(roomId: string): Promise<OriginParticipant[] | null> {
    const originBaseUrl = this.crossRegionJoin.getOriginUrl(roomId);
    if (!originBaseUrl) return null;
    return this.originSnapshot.fetchOriginParticipants(originBaseUrl, roomId);
  }

  async fetchOriginRoomSnapshot(roomId: string, seatCount: number): Promise<OriginRoomSnapshot | null> {
    const originBaseUrl = this.crossRegionJoin.getOriginUrl(roomId);
    if (!originBaseUrl) return null;
    return this.originSnapshot.fetchOriginRoomSnapshot(originBaseUrl, roomId, seatCount);
  }

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

  async setupReversePipe(
    roomId: string, edgeProducer: import("mediasoup").types.Producer,
    cluster: RoomMediaCluster, userId: number,
  ): Promise<{ originProducerId: string } | null> {
    return this.reversePipeLifecycle.setupReversePipe(roomId, edgeProducer, cluster, userId);
  }

  async closeReversePipe(roomId: string, edgeProducerId: string): Promise<void> {
    return this.reversePipeLifecycle.closeReversePipe(roomId, edgeProducerId);
  }

  async cleanup(roomId: string): Promise<void> {
    await this.edgePipeLifecycle.cleanupRoom(roomId);
    await this.pipeManager.closePipes(roomId);
    this.cascadeRelay.cleanupRoom(roomId);
    this.crossRegionJoin.detachRoom(roomId);
    this.logger.debug({ roomId }, "CascadeCoordinator: room cascade cleanup complete");
  }
}
