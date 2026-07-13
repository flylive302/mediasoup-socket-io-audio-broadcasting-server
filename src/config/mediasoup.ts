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
          usedtx: 0, // Disable discontinuous transmission (keep alive)
          minptime: 10, // Low latency packets (10ms)
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
  // 192k = stereo music producer at 128k target + FEC/overhead headroom;
  // voice mics are capped client-side at 64k mono via codecOptions.
  maxIncomingBitrate: 192000,

  // Speaking-indicator settings (AudioLevelObserver: reports ALL producers
  // above threshold each interval — concurrent speakers, not one dominant).
  audioLevelObserver: {
    maxEntries: 16, // max concurrent speakers reported per tick (seat count ceiling)
    threshold: -55, // dBvo — producers louder than this count as "speaking"
    interval: 500, // ms between `volumes` reports; also keeps FE decay timer fresh
  },
};
