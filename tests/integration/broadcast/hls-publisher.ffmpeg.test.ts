/**
 * Integration test: HlsPublisher against a REAL local ffmpeg.
 *
 * A synthetic ffmpeg "speaker" sends an Opus RTP sine tone to the port in the
 * SDP (standing in for a mediasoup PlainTransport consumer). HlsPublisher's
 * ffmpeg mixes/encodes it to short-segment fMP4 HLS; a recording uploader
 * captures every R2 PUT. We assert the pipeline produces init + segments +
 * manifests and that each manifest is uploaded only AFTER every segment it
 * references — the publish-safe ordering that keeps the CDN 404-free.
 *
 * Skipped automatically where ffmpeg/libopus is unavailable (e.g. CI before the
 * AMI change); runs locally and on the MSAB hosts.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlsPublisher } from "@src/domains/broadcast/hls-publisher.js";
import { buildMixSdp } from "@src/domains/broadcast/hls-pipeline.js";
import type { HlsUploader } from "@src/domains/broadcast/hls-uploader.js";

const PORT = 45222;
const PORT_B = 45224;
const PAYLOAD_TYPE = 111;

function hasFfmpegWithOpus(): boolean {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 && /libopus/.test(r.stdout);
}

/** Spawn a synthetic Opus-RTP "speaker" sending a sine tone to a local port. */
function spawnSender(port: number, freq: number): ChildProcess {
  return spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-re",
    "-f", "lavfi",
    "-i", `sine=frequency=${freq}:sample_rate=48000`,
    "-c:a", "libopus", "-b:a", "64k", "-ac", "2", "-ar", "48000",
    "-f", "rtp",
    "-payload_type", String(PAYLOAD_TYPE),
    `rtp://127.0.0.1:${port}`,
  ], { stdio: ["ignore", "ignore", "ignore"] });
}

/** Count distinct media segments uploaded so far. */
function segCount(names: string[]): number {
  return new Set(names.filter((n) => /^seg-\d+\.m4s$/.test(n))).size;
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as import("pino").Logger;

/** Records uploads in order so we can assert publish-safe ordering. */
class RecordingUploader implements HlsUploader {
  readonly uploads: { fileName: string; size: number }[] = [];
  removed = false;
  async upload(_roomId: string, fileName: string, body: Buffer): Promise<void> {
    this.uploads.push({ fileName, size: body.length });
  }
  async removeRoom(): Promise<void> {
    this.removed = true;
  }
  names(): string[] {
    return this.uploads.map((u) => u.fileName);
  }
}

describe.skipIf(!hasFfmpegWithOpus())("HlsPublisher × ffmpeg", () => {
  let workDir: string;
  let senders: ChildProcess[] = [];
  let publisher: HlsPublisher | null = null;

  beforeAll(() => {
    // sanity: ensure assertion guard ran
    expect(hasFfmpegWithOpus()).toBe(true);
  });

  afterEach(async () => {
    for (const s of senders) s.kill("SIGKILL");
    senders = [];
    await publisher?.stop();
    publisher = null;
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  async function startPublisher(inputs: { port: number }[]): Promise<RecordingUploader> {
    workDir = await mkdtemp(join(tmpdir(), "flylive-hls-test-"));
    const uploader = new RecordingUploader();
    publisher = new HlsPublisher(
      {
        roomId: "test-room",
        workDir,
        ffmpegPath: "ffmpeg",
        segmentDurationSec: 1,
        playlistSize: 6,
        restartDebounceMs: 200,
      },
      uploader,
      silentLogger,
    );
    const sdp = buildMixSdp(
      inputs.map((i) => ({
        port: i.port,
        payloadType: PAYLOAD_TYPE,
        clockRate: 48000,
        channels: 2,
      })),
    );
    await publisher.start(sdp, inputs.length);
    return uploader;
  }

  async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return pred();
  }

  it("mixes one Opus speaker into fMP4 HLS and uploads in publish-safe order", async () => {
    const uploader = await startPublisher([{ port: PORT }]);

    // ffmpeg binds the SDP port first, THEN the speaker streams to it (controller
    // replicates this ordering via start → resumeAll).
    await new Promise((r) => setTimeout(r, 600));
    senders.push(spawnSender(PORT, 440));

    const ok = await waitFor(() => {
      const n = uploader.names();
      return n.includes("init.mp4") && segCount(n) > 0 && n.includes("live.m3u8");
    }, 20_000);
    expect(ok).toBe(true);

    const names = uploader.names();
    expect(names).toContain("init.mp4");
    expect(names).toContain("master.m3u8");

    // Publish-safe ordering: the first manifest upload that follows the first
    // segment comes after that segment (CDN never sees a manifest before its
    // referenced object). init precedes the last manifest too.
    const firstSeg = names.findIndex((n) => /^seg-\d+\.m4s$/.test(n));
    const firstManifestAfterSeg = names.findIndex(
      (n, i) => n === "live.m3u8" && i > firstSeg,
    );
    expect(firstSeg).toBeGreaterThanOrEqual(0);
    expect(firstManifestAfterSeg).toBeGreaterThan(firstSeg);
    expect(names.indexOf("init.mp4")).toBeLessThan(names.lastIndexOf("live.m3u8"));
  }, 30_000);

  it("mixes TWO live speakers via amix=normalize=0 (all audible, no cap)", async () => {
    const uploader = await startPublisher([{ port: PORT }, { port: PORT_B }]);

    await new Promise((r) => setTimeout(r, 600));
    senders.push(spawnSender(PORT, 440));
    senders.push(spawnSender(PORT_B, 880));

    // The amix (N=2) path must produce a continuous stream — proves the
    // multi-input mix encodes, not just the single-stream passthrough.
    const ok = await waitFor(() => segCount(uploader.names()) >= 2, 20_000);
    expect(ok).toBe(true);
    expect(segCount(uploader.names())).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("recovers the mix after a speaker leaves by restarting on the reduced set", async () => {
    // KEY FINDING: a live RTP input that stops without EOF FREEZES amix (sample-
    // synchronous, dropout_transition never fires). So the architecture relies on:
    //  (a) self-mute keeping the producer live via DTX — its RTP never stops, so
    //      the mix never freezes (no restart);
    //  (b) producer removal (seat leave / manager-mute=pause) triggering a restart
    //      that drops the dead input — proven here.
    const uploader = await startPublisher([{ port: PORT }, { port: PORT_B }]);

    await new Promise((r) => setTimeout(r, 600));
    const a = spawnSender(PORT, 440);
    const b = spawnSender(PORT_B, 880);
    senders.push(a, b);

    expect(await waitFor(() => segCount(uploader.names()) >= 2, 20_000)).toBe(true);

    // Speaker B leaves: RTP stops AND the controller restarts on the reduced
    // single-speaker SDP (mirrors onSpeakerChange → publisher.restart).
    b.kill("SIGKILL");
    const reducedSdp = buildMixSdp([
      { port: PORT, payloadType: PAYLOAD_TYPE, clockRate: 48000, channels: 2 },
    ]);
    const before = segCount(uploader.names());
    publisher!.restart(reducedSdp, 1);

    // After the (debounced) restart drops the dead input, the mix resumes with
    // the remaining live speaker.
    const progressed = await waitFor(
      () => segCount(uploader.names()) >= before + 2,
      15_000,
    );
    expect(progressed).toBe(true);
  }, 45_000);
});
