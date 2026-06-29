/**
 * HlsUploader — pushes FFmpeg's local HLS artifacts to R2 (realtime-09 REACT).
 *
 * The FFmpeg muxer writes manifests + fMP4 segments to a local work dir; this
 * uploader mirrors each changed file to the R2 bucket under `<roomId>/<file>`,
 * stamping the Content-Type + Cache-Control the CDN relies on (manifests
 * near-realtime, segments immutable — see `hlsObjectHeaders`). Cloudflare serves
 * the objects to Listeners. Upload failure is logged, never thrown — a dropped
 * segment is a momentary gap, not a crash.
 */
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Logger } from "pino";
import { hlsObjectHeaders } from "./hls-pipeline.js";

export interface HlsUploader {
  /** Mirror one local HLS artifact to `<roomId>/<fileName>` in the bucket. */
  upload(roomId: string, fileName: string, body: Buffer): Promise<void>;
  /** Best-effort: delete all objects under `<roomId>/` (publish stop / cleanup). */
  removeRoom(roomId: string): Promise<void>;
}

export interface R2UploaderConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class R2HlsUploader implements HlsUploader {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    cfg: R2UploaderConfig,
    private readonly logger: Logger,
    client?: S3Client,
  ) {
    this.bucket = cfg.bucket;
    this.client =
      client ??
      new S3Client({
        // R2 is single-region from the SDK's view.
        region: "auto",
        endpoint: cfg.endpoint,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
      });
  }

  async upload(roomId: string, fileName: string, body: Buffer): Promise<void> {
    const { contentType, cacheControl } = hlsObjectHeaders(fileName);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${roomId}/${fileName}`,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
        }),
      );
    } catch (err) {
      // REACT: a lost segment is a brief gap; never surface to the pipeline.
      this.logger.warn(
        { err, roomId, fileName },
        "HlsUploader: object upload failed (Listeners may see a brief gap)",
      );
    }
  }

  async removeRoom(roomId: string): Promise<void> {
    try {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${roomId}/` }),
      );
      const objects = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));
      if (objects.length === 0) return;

      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects.map((Key) => ({ Key })) },
        }),
      );
    } catch (err) {
      // The R2 lifecycle rule (1-day expiry) is the backstop if this fails.
      this.logger.warn({ err, roomId }, "HlsUploader: room cleanup failed");
    }
  }
}
