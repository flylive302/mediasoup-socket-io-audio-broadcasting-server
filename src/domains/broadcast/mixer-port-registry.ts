/**
 * MixerPortRegistry — instance-scoped local UDP port allocator for
 * `SpeakerMixer`'s FFmpeg RTP receive legs (aws-app-affinity-10).
 *
 * Previously each `SpeakerMixer` kept its own used-port set, so every Room's
 * mixer started searching at the same base port with no cross-Room registry —
 * two concurrent broadcast Rooms on one instance could both try to bind the
 * same local port, and the second one lost the real OS-level UDP bind.
 *
 * One registry is now shared by every Room's mixer on an instance
 * (constructed once in `createBroadcastController`), so allocation is
 * instance-wide rather than per-mixer. Ports are freed back to the shared
 * pool on release (mirrors the old per-mixer release behaviour) and reused.
 */
import { config } from "@src/config/index.js";

/** Default base port for FFmpeg RTP receive — clear of MEDIASOUP_RTC_MIN_PORT. */
const DEFAULT_BASE_PORT = 5004;

/** Step between candidate ports — leaves the odd port free for RTCP (unused: rtcpMux). */
const PORT_STEP = 2;

/** Thrown when the instance's mixer port pool is exhausted — must surface loudly. */
export class MixerPortsExhaustedError extends Error {
  constructor(basePort: number, maxPort: number) {
    super(
      `MixerPortRegistry: exhausted the local RTP port range [${basePort}, ${maxPort}) — ` +
        `no free port for a new broadcast mix leg on this instance`,
    );
    this.name = "MixerPortsExhaustedError";
  }
}

export class MixerPortRegistry {
  private readonly usedPorts = new Set<number>();

  constructor(
    private readonly basePort: number = DEFAULT_BASE_PORT,
    /** Exclusive upper bound — stays clear of the mediasoup WebRTC port range. */
    private readonly maxPort: number = config.MEDIASOUP_RTC_MIN_PORT,
  ) {}

  /** Lowest free even port at/above basePort. Throws loudly when the range is exhausted. */
  allocate(): number {
    let port = this.basePort;
    while (this.usedPorts.has(port)) {
      port += PORT_STEP;
      if (port >= this.maxPort) {
        throw new MixerPortsExhaustedError(this.basePort, this.maxPort);
      }
    }
    this.usedPorts.add(port);
    return port;
  }

  /** Return a port to the pool so a later allocate() can reuse it. */
  release(port: number): void {
    this.usedPorts.delete(port);
  }
}
