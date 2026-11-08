import type * as mediasoup from "mediasoup";
import { config } from "./index.js";

export const mediasoupConfig = {
  // Worker settings
  worker: {
    rtcMinPort: config.MEDIASOUP_RTC_MIN_PORT,
    rtcMaxPort: config.MEDIASOUP_RTC_MAX_PORT,
    logLevel: "warn",
    logTags: [
      "info",
      "ice",
      "dtls",
      "rtp",
      "srtp",
      "rtcp",
    ] as mediasoup.types.WorkerLogTag[],
  } as mediasoup.types.WorkerSettings,

  // Router settings (preferredPayloadType is assigned by mediasoup at runtime)
  router: {
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        parameters: {
          useinbandfec: 1, // Forward error correction
          // Discontinuous transmission advertised (cost-and-speed-tuning 03).
          // The client mic producer turns it on via `opusDtx: true` and music
          // keeps it off — the producer's own codec parameters are what
          // mediasoup and consumers act on, so this is the default, not a
          // switch. It was 0 because DTX froze the HLS amix; ticket 02
          // hardened the mix graph and proved it on the prod FFmpeg 5.1.9
          // (docs/issues/cost-and-speed-tuning/assets-02-dtx-repro/).
          usedtx: 1,
          minptime: 10, // Lowest packet duration a client may use (10ms); the mic asks for 40
          "sprop-stereo": 1,
        },
      },
    ] as unknown as mediasoup.types.RtpCodecCapability[],
  },

  // WebRTC Transport settings
  webRtcTransport: {
    listenInfos: [
      {
        protocol: "udp",
        ip: config.MEDIASOUP_LISTEN_IP,
        announcedAddress: config.MEDIASOUP_ANNOUNCED_IP,
      },
      {
        protocol: "tcp",
        ip: config.MEDIASOUP_LISTEN_IP,
        announcedAddress: config.MEDIASOUP_ANNOUNCED_IP,
      },
    ] as mediasoup.types.TransportListenInfo[],

    // Bandwidth settings (Audio-only optimization).
    // 128k lets BWE start at full audio quality immediately instead of
    // ramping up from a degraded first few seconds (64k start showed up as
    // "weak audio" at speak start — 2026-07-10 audio review).
    initialAvailableOutgoingBitrate: 128000,
  } as mediasoup.types.WebRtcTransportOptions,

  // Max incoming bitrate per transport (applied via setMaxIncomingBitrate after creation)
  // 256k = DJ transport worst case: stereo music producer at 128k target +
  // the DJ's own voice mic (capped client-side at 96k mono via codecOptions,
  // raised from 64k on 2026-08-23) + FEC/overhead headroom. Was 192k, which
  // starved the music once the mic cap went up.
  maxIncomingBitrate: 256000,

  // Speaking-indicator settings (AudioLevelObserver: reports ALL producers
  // above threshold each interval — concurrent speakers, not one dominant).
  audioLevelObserver: {
    maxEntries: 16, // max concurrent speakers reported per tick (seat count ceiling)
    threshold: -55, // dBvo — producers louder than this count as "speaking"
    interval: 500, // ms between `volumes` reports; also keeps FE decay timer fresh
  },
};
