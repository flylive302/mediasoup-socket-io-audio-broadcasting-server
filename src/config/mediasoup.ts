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

    // Bandwidth settings (Audio-only optimization)
    initialAvailableOutgoingBitrate: 64000,
  } as mediasoup.types.WebRtcTransportOptions,

  // Max incoming bitrate per transport (applied via setMaxIncomingBitrate after creation)
  // 128kbps max incoming per stream is plenty for high quality Opus
  maxIncomingBitrate: 128000,

  // Active Speaker settings
  activeSpeakerObserver: {
    interval: 200, // Check every 200ms
    minVolume: -50, // dB threshold
  },
};
