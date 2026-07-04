import { describe, it, expect } from "vitest";
import {
  buildMixSdp,
  buildFfmpegArgs,
  parsePlaylistRefs,
  maxSegmentIndex,
  hlsObjectHeaders,
  hlsInitName,
  hlsSegmentTemplate,
  isHlsInitFile,
  HLS_FILES,
  type MixInput,
  type HlsOutputConfig,
} from "@src/domains/broadcast/hls-pipeline.js";

const input = (port: number, pt: number): MixInput => ({
  port,
  payloadType: pt,
  clockRate: 48000,
  channels: 2,
});

const cfg = (startNumber = 0, sessionNonce = ""): HlsOutputConfig => ({
  ffmpegPath: "ffmpeg",
  workDir: "/work",
  sdpPath: "/work/room.sdp",
  segmentDurationSec: 1,
  playlistSize: 6,
  startNumber,
  sessionNonce,
});

describe("buildMixSdp", () => {
  it("emits one recvonly Opus m-line per speaker on its own port", () => {
    const sdp = buildMixSdp([input(5004, 111), input(5006, 100)]);
    expect(sdp).toContain("m=audio 5004 RTP/AVP 111");
    expect(sdp).toContain("a=rtpmap:111 opus/48000/2");
    expect(sdp).toContain("m=audio 5006 RTP/AVP 100");
    expect(sdp).toContain("a=rtpmap:100 opus/48000/2");
    expect(sdp.match(/a=recvonly/g)).toHaveLength(2);
    expect(sdp.endsWith("\n")).toBe(true);
  });

  it("produces a header-only SDP for zero inputs", () => {
    const sdp = buildMixSdp([]);
    expect(sdp).toContain("v=0");
    expect(sdp).not.toContain("m=audio");
  });
});

describe("buildFfmpegArgs", () => {
  it("routes the single stream through aresample (continuous clock, no amix)", () => {
    const args = buildFfmpegArgs(1, cfg());
    const joined = args.join(" ");
    expect(joined).toContain("-map [a]");
    // Single DTX source must be resampled to a steady timeline or the muxer stalls.
    expect(joined).toContain("[0:a:0]aresample=async=1:first_pts=0[a]");
    expect(joined).not.toContain("amix");
  });

  it("mixes N>=2 speakers with normalize=0 at unity gain, each input resampled", () => {
    const args = buildFfmpegArgs(3, cfg());
    const joined = args.join(" ");
    // Per-input aresample (continuous clock, jitter/DTX-gap smoothing) then amix.
    expect(joined).toContain(
      "[0:a:0]aresample=async=1:first_pts=0[a0];[0:a:1]aresample=async=1:first_pts=0[a1];[0:a:2]aresample=async=1:first_pts=0[a2];[a0][a1][a2]amix=inputs=3:normalize=0:dropout_transition=0[a]",
    );
    expect(joined).toContain("-map [a]");
  });

  it("emits fMP4 short-segment HLS with a master playlist and continued numbering", () => {
    const args = buildFfmpegArgs(2, cfg(42));
    const joined = args.join(" ");
    expect(joined).toContain("-hls_segment_type fmp4");
    expect(joined).toContain("-hls_time 1");
    expect(joined).toContain("-hls_list_size 6");
    expect(joined).toContain(`-hls_fmp4_init_filename ${HLS_FILES.init}`);
    expect(joined).toContain(`-master_pl_name ${HLS_FILES.master}`);
    expect(joined).toContain("-start_number 42");
    expect(joined).toContain("discont_start");
    expect(args[args.length - 1]).toBe(`/work/${HLS_FILES.media}`);
  });

  it("rejects an empty mix", () => {
    expect(() => buildFfmpegArgs(0, cfg())).toThrow();
  });

  it("bakes the session nonce into the init + segment file names (realtime-19)", () => {
    const args = buildFfmpegArgs(2, cfg(0, "a1b2c3d4"));
    const joined = args.join(" ");
    // Immutable children carry the nonce so a new session can't collide with a
    // previous session's CDN-cached objects.
    expect(joined).toContain("-hls_fmp4_init_filename init-a1b2c3d4.mp4");
    expect(joined).toContain("-hls_segment_filename /work/seg-a1b2c3d4-%05d.m4s");
    // Manifests keep their stable names → playback URL unchanged.
    expect(joined).toContain(`-master_pl_name ${HLS_FILES.master}`);
    expect(args[args.length - 1]).toBe(`/work/${HLS_FILES.media}`);
  });

  it("falls back to legacy bare names for an empty nonce", () => {
    const joined = buildFfmpegArgs(2, cfg(0, "")).join(" ");
    expect(joined).toContain(`-hls_fmp4_init_filename ${HLS_FILES.init}`);
    expect(joined).toContain(`-hls_segment_filename /work/${HLS_FILES.segmentTemplate}`);
  });
});

describe("nonce naming helpers (realtime-19)", () => {
  it("derives nonce'd names, legacy on empty", () => {
    expect(hlsInitName("a1b2c3d4")).toBe("init-a1b2c3d4.mp4");
    expect(hlsInitName("")).toBe(HLS_FILES.init);
    expect(hlsSegmentTemplate("a1b2c3d4")).toBe("seg-a1b2c3d4-%05d.m4s");
    expect(hlsSegmentTemplate("")).toBe(HLS_FILES.segmentTemplate);
  });

  it("identifies init files (bare or nonce'd), never a segment/manifest", () => {
    expect(isHlsInitFile("init.mp4")).toBe(true);
    expect(isHlsInitFile("init-a1b2c3d4.mp4")).toBe(true);
    expect(isHlsInitFile("seg-a1b2c3d4-00001.m4s")).toBe(false);
    expect(isHlsInitFile("live.m3u8")).toBe(false);
  });
});

describe("parsePlaylistRefs", () => {
  it("extracts the init map and media segments, ignoring tags", () => {
    const m3u8 = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:1",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:1.000,",
      "seg-00000.m4s",
      "#EXTINF:1.000,",
      "seg-00001.m4s",
    ].join("\n");
    expect(parsePlaylistRefs(m3u8)).toEqual([
      "init.mp4",
      "seg-00000.m4s",
      "seg-00001.m4s",
    ]);
  });

  it("returns bare file names even if a URI carries a path", () => {
    expect(parsePlaylistRefs('#EXT-X-MAP:URI="sub/init.mp4"\nsub/seg-1.m4s')).toEqual([
      "init.mp4",
      "seg-1.m4s",
    ]);
  });
});

describe("maxSegmentIndex", () => {
  it("finds the highest seg index, -1 when none", () => {
    expect(maxSegmentIndex(["seg-00003.m4s", "seg-00010.m4s", "init.mp4"])).toBe(10);
    expect(maxSegmentIndex(["init.mp4", "live.m3u8"])).toBe(-1);
  });

  it("matches nonce'd segment names so startNumber continuity survives (realtime-19)", () => {
    // A bare-only regex would return -1 here → reset numbering to 0 each restart.
    expect(
      maxSegmentIndex(["seg-a1b2c3d4-00003.m4s", "seg-a1b2c3d4-00010.m4s", "init-a1b2c3d4.mp4"]),
    ).toBe(10);
    // Mixed (defensive) still resolves the max.
    expect(maxSegmentIndex(["seg-00005.m4s", "seg-a1b2c3d4-00012.m4s"])).toBe(12);
  });
});

describe("hlsObjectHeaders", () => {
  it("manifests are near-realtime", () => {
    expect(hlsObjectHeaders("live.m3u8")).toEqual({
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "public, max-age=1",
    });
  });
  it("init + segments are immutable for 60s", () => {
    expect(hlsObjectHeaders("init.mp4")).toEqual({
      contentType: "video/mp4",
      cacheControl: "public, max-age=60, immutable",
    });
    expect(hlsObjectHeaders("seg-00001.m4s")).toEqual({
      contentType: "video/iso.segment",
      cacheControl: "public, max-age=60, immutable",
    });
  });
  it("unknown artifacts are uncacheable", () => {
    expect(hlsObjectHeaders("weird.xyz").cacheControl).toBe("no-store");
  });
});
