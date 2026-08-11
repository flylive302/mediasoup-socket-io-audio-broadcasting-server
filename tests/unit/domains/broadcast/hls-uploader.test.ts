import { describe, it, expect, vi, beforeEach } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { R2HlsUploader } from "@src/domains/broadcast/hls-uploader.js";
import { metrics } from "@src/infrastructure/metrics.js";

/**
 * ticket 32 pt.3: HlsUploader's two existing catch blocks (both already
 * `logger.warn` + swallow — REACT, never throw into the FFmpeg/publish
 * pipeline) had no metric. `operation` labels what the real log messages
 * already say: "object upload failed" and "room cleanup failed" — every
 * artifact (segment, init, master, media manifest) goes through the same
 * `upload()` method, so `object_upload` is more accurate than a
 * segment-only label.
 */
describe("R2HlsUploader failure metrics", () => {
  const cfg = {
    endpoint: "https://example.r2.cloudflarestorage.com",
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "hls-bucket",
  };
  const logger = { warn: vi.fn(), debug() {}, info() {}, error() {} } as any;

  const counterValue = async (labels: Record<string, string>) => {
    const { values } = await metrics.hlsUploaderFailures.get();
    return values.find(
      (v) => JSON.stringify(v.labels) === JSON.stringify(labels),
    )?.value ?? 0;
  };

  beforeEach(() => {
    metrics.hlsUploaderFailures.reset();
    logger.warn.mockClear();
  });

  it("labels a failed upload() as object_upload and still swallows the error", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network blip"));
    const client = { send } as unknown as S3Client;
    const uploader = new R2HlsUploader(cfg, logger, client);

    const before = await counterValue({ operation: "object_upload" });

    // REACT: must resolve, never reject — a lost segment is a brief gap.
    await expect(
      uploader.upload("room-1", "live.m3u8", Buffer.from("x")),
    ).resolves.toBeUndefined();

    expect((await counterValue({ operation: "object_upload" })) - before).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("labels a failed removeRoom() as room_cleanup and still swallows the error", async () => {
    const send = vi.fn().mockRejectedValue(new Error("list failed"));
    const client = { send } as unknown as S3Client;
    const uploader = new R2HlsUploader(cfg, logger, client);

    const before = await counterValue({ operation: "room_cleanup" });

    await expect(uploader.removeRoom("room-1")).resolves.toBeUndefined();

    expect((await counterValue({ operation: "room_cleanup" })) - before).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not increment on a successful upload()", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const uploader = new R2HlsUploader(cfg, logger, client);

    const before = await counterValue({ operation: "object_upload" });
    await uploader.upload("room-1", "live.m3u8", Buffer.from("x"));

    expect(await counterValue({ operation: "object_upload" })).toBe(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not increment removeRoom() when there is nothing to delete", async () => {
    // ListObjectsV2Command resolves with no Contents — the early return path,
    // never reaches the DeleteObjectsCommand or the catch block.
    const send = vi.fn().mockResolvedValue({ Contents: [] });
    const client = { send } as unknown as S3Client;
    const uploader = new R2HlsUploader(cfg, logger, client);

    const before = await counterValue({ operation: "room_cleanup" });
    await uploader.removeRoom("room-1");

    expect(await counterValue({ operation: "room_cleanup" })).toBe(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
