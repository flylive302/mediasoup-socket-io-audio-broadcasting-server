import { describe, it, expect } from "vitest";
import {
  buildMixSdp,
  buildFfmpegArgs,
  parsePlaylistRefs,
  maxSegmentIndex,
  hlsObjectHeaders,
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

const cfg = (startNumber = 0): HlsOutputConfig => ({
  ffmpegPath: "ffmpeg",
  workDir: "/work",
  sdpPath: "/work/room.sdp",
  segmentDurationSec: 1,
  playlistSize: 6,
  startNumber,
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
  it("maps the single stream directly when there is one speaker (no amix)", () => {
    const args = buildFfmpegArgs(1, cfg());
    expect(args).toContain("-map");
    expect(args).toContain("0:a:0");
    expect(args.join(" ")).not.toContain("amix");
  });

  it("mixes N>=2 speakers with normalize=0 at unity gain", () => {
    const args = buildFfmpegArgs(3, cfg());
    const joined = args.join(" ");
    expect(joined).toContain(
      "[0:a:0][0:a:1][0:a:2]amix=inputs=3:normalize=0:dropout_transition=0[a]",
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
