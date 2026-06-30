/**
 * hls-pipeline — pure builders for the broadcast LL-HLS pipeline (realtime-09).
 *
 * No IO, no mediasoup, no ffmpeg process: given the per-speaker RTP descriptors
 * and the output config, build (a) the SDP that tells FFmpeg how to receive each
 * speaker's RTP and (b) the FFmpeg argv that mixes them into one short-segment
 * HLS stream. Fully unit-testable; the stateful `SpeakerMixer` / `HlsPublisher`
 * compose these.
 *
 * ## Mixing contract (locked decisions)
 *  - Mix set = **every seated speaker's live producer**, continuous. Opus DTX
 *    keeps a self-muted (client track-disabled) mic near-free and audible-silent,
 *    so the input topology changes only on producer add/remove — never on mute.
 *  - `amix=inputs=N:normalize=0` — `normalize=0` is mandatory: the default divides
 *    every input's gain by N, so one talker among 15 silent seats would play at
 *    1/15 volume. With normalize off each speaker keeps unity gain.
 *  - Short-segment HLS (~1s), NOT true LL-HLS partial segments: R2 is object
 *    storage, not an LL-HLS origin (no blocking playlist reload / chunked CMAF).
 *    ~1s segments → ~3–5s glass-to-glass, the realtime-09 "~2–5s" target.
 */

/** One speaker's RTP stream, as mediasoup will send it to FFmpeg. */
export interface MixInput {
  /** Local UDP port FFmpeg binds to receive this speaker's RTP. */
  port: number;
  /** RTP payload type from the mediasoup consumer's rtpParameters. */
  payloadType: number;
  /** Opus clock rate (always 48000 for mediasoup Opus). */
  clockRate: number;
  /** Channel count (2 for mediasoup Opus). */
  channels: number;
}

export interface HlsOutputConfig {
  ffmpegPath: string;
  /** Absolute path to the per-room work directory (tmpfs/local scratch). */
  workDir: string;
  /** Absolute path to the SDP file FFmpeg reads as its single input. */
  sdpPath: string;
  segmentDurationSec: number;
  playlistSize: number;
  /** First media-segment index for this (re)start — preserves numbering across restarts. */
  startNumber: number;
}

/** Output file names (relative to workDir) the pipeline produces. */
export const HLS_FILES = {
  media: "live.m3u8",
  master: "master.m3u8",
  init: "init.mp4",
  /** FFmpeg segment template; `%05d` is the segment index. */
  segmentTemplate: "seg-%05d.m4s",
} as const;

/**
 * Build the SDP describing N inbound Opus RTP streams (one m-line per speaker).
 * FFmpeg binds each port and exposes the streams as 0:a:0 … 0:a:(N-1).
 */
export function buildMixSdp(inputs: MixInput[]): string {
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=FlyLiveBroadcastMix",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
  ];
  for (const input of inputs) {
    lines.push(
      `m=audio ${input.port} RTP/AVP ${input.payloadType}`,
      `a=rtpmap:${input.payloadType} opus/${input.clockRate}/${input.channels}`,
      "a=recvonly",
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Build the FFmpeg argv that receives the SDP's N Opus streams, mixes them at
 * unity gain, and writes a short-segment fMP4 HLS playlist + master into workDir.
 *
 * - N === 1: map the single stream directly (amix requires ≥2 inputs).
 * - N >= 2: `amix=inputs=N:normalize=0`.
 * Caller guarantees N >= 1 (no speakers ⇒ publisher is stopped, not run empty).
 */
export function buildFfmpegArgs(
  inputCount: number,
  cfg: HlsOutputConfig,
): string[] {
  if (inputCount < 1) {
    throw new Error("buildFfmpegArgs requires at least one mix input");
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    // RTP over UDP read from a local SDP file.
    "-protocol_whitelist",
    "file,rtp,udp",
    // Generate PTS from arrival timing — RTP inputs carry no container timestamps.
    "-fflags",
    "+genpts",
    "-i",
    cfg.sdpPath,
  ];

  if (inputCount === 1) {
    // A single live Opus RTP source uses DTX, so its RTP goes sparse during
    // silence. Mapped directly the HLS muxer gets no steady sample clock, FFmpeg
    // stalls and never writes a segment/manifest (prod symptom: single speaker →
    // master.m3u8 404, no audio). Route it through aresample=async to resample
    // onto a continuous timeline, filling silence gaps so segments are always
    // produced. (The N>=2 amix path gets this continuity for free — which is why
    // two speakers worked while one did not.)
    args.push(
      "-filter_complex",
      "[0:a:0]aresample=async=1:first_pts=0[a]",
      "-map",
      "[a]",
    );
  } else {
    // Resample each input onto a continuous timeline BEFORE mixing. Real Opus RTP
    // carries timing jitter + DTX silence gaps; fed straight into the
    // sample-synchronous amix these surface as a steady hiss/static. aresample=async
    // resyncs each input's clock and fills gaps with clean silence, so amix mixes
    // time-aligned samples. normalize=0 keeps unity gain (default divides by N).
    const resampled = Array.from(
      { length: inputCount },
      (_, i) => `[0:a:${i}]aresample=async=1:first_pts=0[a${i}]`,
    ).join(";");
    const labels = Array.from({ length: inputCount }, (_, i) => `[a${i}]`).join("");
    args.push(
      "-filter_complex",
      `${resampled};${labels}amix=inputs=${inputCount}:normalize=0:dropout_transition=0[a]`,
      "-map",
      "[a]",
    );
  }

  args.push(
    // AAC is the HLS-universal codec; 48k/stereo matches the Opus source.
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    String(cfg.segmentDurationSec),
    "-hls_list_size",
    String(cfg.playlistSize),
    // delete_segments: bound local disk. append_list + discont_start + start_number:
    // a restart (seat change / force-mute) continues the same playlist with an
    // EXT-X-DISCONTINUITY so hls.js recovers with one catch-up jump, not a 404 storm.
    "-hls_flags",
    "delete_segments+append_list+discont_start+independent_segments+omit_endlist",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    HLS_FILES.init,
    "-hls_segment_filename",
    `${cfg.workDir}/${HLS_FILES.segmentTemplate}`,
    "-start_number",
    String(cfg.startNumber),
    "-master_pl_name",
    HLS_FILES.master,
    `${cfg.workDir}/${HLS_FILES.media}`,
  );

  return args;
}

/**
 * Extract the local artifact file names a media playlist references — the
 * `EXT-X-MAP` init segment plus every media-segment URI. Used to enforce
 * publish ordering: every referenced object must be uploaded to R2 *before* the
 * manifest that points at it, so the CDN never serves a manifest with a 404.
 * Only bare file names are returned (FFmpeg writes flat into the work dir).
 */
export function parsePlaylistRefs(m3u8: string): string[] {
  const refs: string[] = [];
  for (const raw of m3u8.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      // EXT-X-MAP:URI="init.mp4"
      const map = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
      if (map?.[1]) refs.push(basename(map[1]));
      continue;
    }
    // A non-tag line is a media segment URI.
    refs.push(basename(line));
  }
  return refs;
}

/** Highest `seg-NNNNN.m4s` index among file names, or -1 if none. */
export function maxSegmentIndex(fileNames: string[]): number {
  let max = -1;
  for (const name of fileNames) {
    const m = name.match(/^seg-(\d+)\.m4s$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** R2/CDN object headers per file type — the contract from realtime-09 provisioning. */
export interface ObjectHeaders {
  contentType: string;
  cacheControl: string;
}

/**
 * Resolve Content-Type + Cache-Control for an HLS artifact by extension.
 * Manifests are near-realtime (max-age=1); segments + init are immutable for 60s.
 * Matches the Cloudflare cache rule (respect-origin) provisioned for the bucket.
 */
export function hlsObjectHeaders(fileName: string): ObjectHeaders {
  if (fileName.endsWith(".m3u8")) {
    return {
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "public, max-age=1",
    };
  }
  if (fileName.endsWith(".mp4")) {
    return {
      contentType: "video/mp4",
      cacheControl: "public, max-age=60, immutable",
    };
  }
  if (fileName.endsWith(".m4s")) {
    return {
      contentType: "video/iso.segment",
      cacheControl: "public, max-age=60, immutable",
    };
  }
  // Unknown artifact — safe, uncacheable default.
  return { contentType: "application/octet-stream", cacheControl: "no-store" };
}
