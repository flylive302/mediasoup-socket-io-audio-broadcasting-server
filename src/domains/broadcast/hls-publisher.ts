/**
 * HlsPublisher — the FFmpeg + R2 half of the broadcast pipeline (realtime-09).
 *
 * Given an SDP (from `SpeakerMixer`) and the speaker count, it:
 *  1. writes the SDP to the work dir and spawns one FFmpeg that mixes the N Opus
 *     RTP streams into a short-segment fMP4 HLS playlist (`buildFfmpegArgs`);
 *  2. watches the work dir and mirrors artifacts to R2 in **publish-safe order** —
 *     init + referenced segments first, then the manifest — so the CDN never
 *     serves a manifest pointing at a missing object.
 *
 * `restart()` is debounced: a burst of topology changes (seat join/leave,
 * moderator force-mute) coalesces into ONE FFmpeg restart, so Listeners rebuffer
 * once. Segment numbering continues across restarts (`startNumber`) and FFmpeg
 * emits an `EXT-X-DISCONTINUITY`, so hls.js recovers with a single catch-up jump.
 *
 * Self-mute never reaches here — the producer stays live (DTX), so the SDP and
 * topology are unchanged.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  buildFfmpegArgs,
  parsePlaylistRefs,
  maxSegmentIndex,
  isHlsInitFile,
  HLS_FILES,
  type HlsOutputConfig,
} from "./hls-pipeline.js";
import type { HlsUploader } from "./hls-uploader.js";
import { reactError } from "@src/shared/react-error.js";

export interface HlsPublisherOptions {
  roomId: string;
  workDir: string;
  ffmpegPath: string;
  segmentDurationSec: number;
  playlistSize: number;
  restartDebounceMs: number;
}

export class HlsPublisher {
  private ffmpeg: ChildProcess | null = null;
  private watcher: FSWatcher | null = null;
  /** Next media-segment index — continues across restarts so numbering is monotonic. */
  private startNumber = 0;
  /**
   * realtime-19: per-session nonce baked into init/segment file names so a new
   * session's immutable objects never collide with a previous session's CDN-cached
   * ones (stale-clip replay). Minted in `start()` (session boundary); held stable
   * across intra-session `restart()` so numbering/continuity survives.
   */
  private sessionNonce = "";
  /** Segments already on R2 (immutable, never re-uploaded). */
  private readonly uploadedSegments = new Set<string>();
  private masterUploaded = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private pendingRestart: { sdp: string; inputCount: number } | null = null;
  /** Serialise manifest processing so overlapping fs events don't double-upload. */
  private processing = false;
  private dirty = false;
  private stopped = false;

  constructor(
    private readonly opts: HlsPublisherOptions,
    private readonly uploader: HlsUploader,
    private readonly logger: Logger,
  ) {}

  private get sdpPath(): string {
    return join(this.opts.workDir, `${this.opts.roomId}.sdp`);
  }

  /** Start publishing for the given SDP / speaker count (first start). */
  async start(sdp: string, inputCount: number): Promise<void> {
    this.stopped = false;
    // A prior stop() ran removeRoom(), wiping this room's R2 objects. Reset the
    // upload-dedup state so this (re)start re-publishes master.m3u8 + a fresh
    // init/segment set. Without this, an all-speakers-left → returned cycle (or a
    // transient mixer.size===0 reconcile) leaves master.m3u8 permanently 404 on
    // the CDN because masterUploaded stayed true while R2 no longer has it.
    // (restart() — topology change without a stop — intentionally keeps these.)
    this.masterUploaded = false;
    this.uploadedSegments.clear();
    // realtime-19: mint a fresh per-session nonce so this session's init/segment
    // objects land at new R2 keys — a late joiner can't be served a previous
    // session's immutable (CDN-cached) segment. restart() keeps this nonce.
    this.sessionNonce = randomBytes(4).toString("hex");
    await mkdir(this.opts.workDir, { recursive: true });
    await this.spawnFfmpeg(sdp, inputCount);
    this.startWatching();
  }

  /**
   * Topology changed — restart FFmpeg with the new SDP, debounced. The latest
   * pending SDP wins; the timer fires once for a burst.
   */
  restart(sdp: string, inputCount: number): void {
    if (this.stopped) return;
    this.pendingRestart = { sdp, inputCount };
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const pending = this.pendingRestart;
      this.pendingRestart = null;
      if (!pending || this.stopped) return;
      void this.spawnFfmpeg(pending.sdp, pending.inputCount).catch((err) =>
        reactError(err, { roomId: this.opts.roomId }, "HlsPublisher: restart failed", { level: "error", logger: this.logger }),
      );
    }, this.opts.restartDebounceMs);
  }

  /** Stop publishing: kill FFmpeg, stop watching, clear R2 objects. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.killFfmpeg();
    await this.uploader.removeRoom(this.opts.roomId);
    await rm(this.opts.workDir, { recursive: true, force: true }).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────
  // FFmpeg process
  // ─────────────────────────────────────────────────────────────────

  private async spawnFfmpeg(sdp: string, inputCount: number): Promise<void> {
    this.killFfmpeg();
    await writeFile(this.sdpPath, sdp, "utf8");

    const cfg: HlsOutputConfig = {
      ffmpegPath: this.opts.ffmpegPath,
      workDir: this.opts.workDir,
      sdpPath: this.sdpPath,
      segmentDurationSec: this.opts.segmentDurationSec,
      playlistSize: this.opts.playlistSize,
      startNumber: this.startNumber,
      sessionNonce: this.sessionNonce,
    };
    const args = buildFfmpegArgs(inputCount, cfg);

    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.ffmpeg = proc;

    proc.stderr?.on("data", (chunk: Buffer) => {
      // FFmpeg runs at -loglevel warning, so anything on stderr is already a
      // warning/error worth surfacing (jitter, PTS discontinuity, buffer
      // underrun) — log at warn so it's visible at prod's info level, not
      // swallowed at debug.
      this.logger.warn(
        { roomId: this.opts.roomId, ffmpeg: chunk.toString().trim() },
        "ffmpeg",
      );
    });
    proc.on("exit", (code, signal) => {
      if (this.ffmpeg === proc) this.ffmpeg = null;
      // An unexpected exit (not our kill) while still publishing — log; the
      // controller's lifecycle owns recovery on the next mode/seat evaluation.
      if (!this.stopped && signal !== "SIGKILL") {
        this.logger.warn(
          { roomId: this.opts.roomId, code, signal },
          "HlsPublisher: ffmpeg exited unexpectedly",
        );
      }
    });
  }

  private killFfmpeg(): void {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      this.ffmpeg.kill("SIGKILL");
    }
    this.ffmpeg = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Work-dir watch → R2 (publish-safe ordering)
  // ─────────────────────────────────────────────────────────────────

  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.opts.workDir, () => this.scheduleProcess());
    } catch (err) {
      this.logger.error(
        { err, workDir: this.opts.workDir },
        "HlsPublisher: failed to watch work dir",
      );
    }
    // Kick once in case files already exist before the watcher attached.
    this.scheduleProcess();
  }

  /** Coalesce a burst of fs events into a single serial processing pass. */
  private scheduleProcess(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.processing) return;
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    this.processing = true;
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        await this.publishOnce();
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * One publish pass: read the media playlist, upload its referenced init +
   * segments that aren't on R2 yet, then upload the manifests last (master once).
   */
  private async publishOnce(): Promise<void> {
    const mediaPath = join(this.opts.workDir, HLS_FILES.media);
    let manifest: string;
    try {
      manifest = await readFile(mediaPath, "utf8");
    } catch {
      return; // playlist not written yet
    }

    const refs = parsePlaylistRefs(manifest);

    // Track numbering so a restart continues monotonically.
    const localFiles = await readdir(this.opts.workDir).catch(() => [] as string[]);
    const highest = maxSegmentIndex(localFiles);
    if (highest >= this.startNumber) this.startNumber = highest + 1;

    // 1. Referenced artifacts (init + segments) before the manifest.
    for (const ref of refs) {
      if (this.uploadedSegments.has(ref)) continue;
      const body = await readFile(join(this.opts.workDir, ref)).catch(() => null);
      if (!body) continue; // not fully written yet — next pass picks it up
      await this.uploader.upload(this.opts.roomId, ref, body);
      // The fMP4 init segment can be rewritten on restart, so don't pin it as
      // immutable (realtime-19: matches the bare or nonce'd init name).
      if (!isHlsInitFile(ref)) this.uploadedSegments.add(ref);
    }

    // 2. Master playlist (written once at start).
    if (!this.masterUploaded) {
      const masterBody = await readFile(
        join(this.opts.workDir, HLS_FILES.master),
      ).catch(() => null);
      if (masterBody) {
        await this.uploader.upload(this.opts.roomId, HLS_FILES.master, masterBody);
        this.masterUploaded = true;
      }
    }

    // 3. Media manifest last — now every URI it references is already on R2.
    await this.uploader.upload(
      this.opts.roomId,
      HLS_FILES.media,
      Buffer.from(manifest, "utf8"),
    );
  }
}
