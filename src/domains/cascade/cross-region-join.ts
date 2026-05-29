import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { RoomRegistry, InstanceInfo } from "@src/domains/room/room-registry.js";
import type { CascadeRelay } from "./cascade-relay.js";
import type { EdgePipeLifecycle } from "./edge-pipe-lifecycle.js";
import type { OriginSnapshot } from "./origin-snapshot.js";
import type { CascadeJoinResult, RemoteInstance } from "./types.js";

const OWNER_POLL_ATTEMPTS = 5;
const OWNER_POLL_INTERVAL_MS = 200;

export class CrossRegionJoin {
  /** roomId → origin base URL (only set on edge instances) */
  private readonly _originUrls = new Map<string, string>();

  private readonly selfRegion: string;

  /** Set after construction to break the construct-order cycle with EdgePipeLifecycle. */
  private edgePipeLifecycle!: EdgePipeLifecycle;

  constructor(
    private readonly roomRegistry: RoomRegistry,
    private readonly laravelClient: LaravelClient,
    private readonly cascadeRelay: CascadeRelay,
    private readonly originSnapshot: OriginSnapshot,
    private readonly logger: Logger,
  ) {
    this.selfRegion = config.AWS_REGION;
  }

  bindEdgePipeLifecycle(lifecycle: EdgePipeLifecycle): void {
    this.edgePipeLifecycle = lifecycle;
  }

  get originUrls(): ReadonlyMap<string, string> {
    return this._originUrls;
  }

  isEdgeRoom(roomId: string): boolean {
    return this._originUrls.has(roomId);
  }

  getOriginUrl(roomId: string): string | null {
    return this._originUrls.get(roomId) ?? null;
  }

  detachRoom(roomId: string): void {
    this._originUrls.delete(roomId);
  }

  async handleCrossRegionJoin(roomId: string): Promise<CascadeJoinResult> {
    if (!config.CASCADE_ENABLED) {
      return { isEdge: false };
    }

    const cascadeInfo = await this.laravelClient.getCascadeInfo(roomId);

    if (!cascadeInfo.is_live || !cascadeInfo.hosting_region) {
      this.logger.debug({ roomId }, "CrossRegionJoin: room not live remotely");
      return { isEdge: false };
    }

    if (cascadeInfo.hosting_region === this.selfRegion) {
      this.logger.debug({ roomId }, "CrossRegionJoin: room in same region, skipping cascade");
      return { isEdge: false };
    }

    if (!cascadeInfo.hosting_ip || !cascadeInfo.hosting_port) {
      this.logger.warn(
        { roomId, cascadeInfo },
        "CrossRegionJoin: cross-region room missing hosting_ip/port",
      );
      return { isEdge: false };
    }

    const originBaseUrl = `http://${cascadeInfo.hosting_ip}:${cascadeInfo.hosting_port}`;
    const originInstanceId = await this.originSnapshot.fetchOriginInstanceId(originBaseUrl);
    if (!originInstanceId) {
      this.logger.warn(
        { roomId, originBaseUrl },
        "CrossRegionJoin: cannot attach to cross-region origin without instanceId",
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
      "CrossRegionJoin: cross-region room detected, becoming edge",
    );

    return {
      isEdge: true,
      originIp: cascadeInfo.hosting_ip,
      originPort: cascadeInfo.hosting_port,
      originRegion: cascadeInfo.hosting_region,
    };
  }

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
        "CrossRegionJoin: owner InstanceInfo never appeared (origin init failed?)",
      );
      return { isEdge: false };
    }

    await this.attachToOrigin(roomId, origin.ip, origin.port, origin.instanceId);

    this.logger.info(
      { roomId, ownerInstanceId, originIp: origin.ip, originPort: origin.port },
      "CrossRegionJoin: same-region edge attached",
    );

    return {
      isEdge: true,
      originIp: origin.ip,
      originPort: origin.port,
      originRegion: this.selfRegion,
    };
  }

  private async attachToOrigin(
    roomId: string,
    originIp: string,
    originPort: number,
    originInstanceId: string,
  ): Promise<void> {
    const originBaseUrl = `http://${originIp}:${originPort}`;
    this._originUrls.set(roomId, originBaseUrl);

    const originInstance: RemoteInstance = {
      instanceId: originInstanceId,
      baseUrl: originBaseUrl,
    };
    this.cascadeRelay.registerRemote(roomId, originInstance);

    try {
      await this.edgePipeLifecycle.notifyOriginEdgeRegistered(originBaseUrl, roomId);
    } catch (err) {
      this.logger.error({ err, roomId }, "CrossRegionJoin: failed to notify origin");
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
}
