/**
 * broadcast domain — LL-HLS broadcast publish tier (realtime-09).
 *
 * `createBroadcastController` wires the production pipeline (R2 uploader +
 * per-Room SpeakerMixer + HlsPublisher) from config. When BROADCAST_HLS_ENABLED
 * is off it returns a fully no-op controller (the mode flip stays realtime-08
 * telemetry), so callers never branch on the flag.
 */
import { join } from "node:path";
import type * as mediasoup from "mediasoup";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import { R2HlsUploader, type HlsUploader } from "./hls-uploader.js";
import { SpeakerMixer } from "./speaker-mixer.js";
import { HlsPublisher } from "./hls-publisher.js";
import {
  BroadcastPublishController,
  type ClusterView,
} from "./broadcast-publish-controller.js";

export { BroadcastPublishController } from "./broadcast-publish-controller.js";
export type { ModeTransition } from "./broadcast-publish-controller.js";

/** ms to let FFmpeg bind the SDP ports before consumers resume (port-bind grace). */
const STARTUP_GRACE_MS = 500;

export function createBroadcastController(
  roomManager: RoomManager,
): BroadcastPublishController {
  if (!config.BROADCAST_HLS_ENABLED) {
    return new BroadcastPublishController({
      enabled: false,
      startupGraceMs: 0,
      getCluster: () => undefined,
      createMixer: () => {
        throw new Error("broadcast disabled");
      },
      createPublisher: () => {
        throw new Error("broadcast disabled");
      },
      logger,
    });
  }

  // Required-when-enabled (config refine guarantees these are present).
  const uploader: HlsUploader = new R2HlsUploader(
    {
      endpoint: config.HLS_R2_ENDPOINT!,
      accessKeyId: config.HLS_R2_ACCESS_KEY_ID!,
      secretAccessKey: config.HLS_R2_SECRET_ACCESS_KEY!,
      bucket: config.HLS_R2_BUCKET!,
    },
    logger,
  );

  return new BroadcastPublishController({
    enabled: true,
    startupGraceMs: STARTUP_GRACE_MS,
    getCluster: (roomId): ClusterView | undefined => {
      const cluster = roomManager.getRoom(roomId);
      if (!cluster) return undefined;
      return {
        router: cluster.router,
        getSourceProducers: () => cluster.getSourceProducers(),
        getProducer: (id) => cluster.getProducer(id),
      };
    },
    createMixer: (router) =>
      new SpeakerMixer(router as mediasoup.types.Router, logger),
    createPublisher: (roomId) =>
      new HlsPublisher(
        {
          roomId,
          workDir: join(config.HLS_WORK_DIR, roomId),
          ffmpegPath: config.HLS_FFMPEG_PATH,
          segmentDurationSec: config.HLS_SEGMENT_DURATION_SEC,
          playlistSize: config.HLS_PLAYLIST_SIZE,
          restartDebounceMs: config.HLS_RESTART_DEBOUNCE_MS,
        },
        uploader,
        logger,
      ),
    logger,
  });
}
