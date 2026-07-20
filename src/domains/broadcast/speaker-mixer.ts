/**
 * SpeakerMixer — mediasoup-side RTP egress for the broadcast tier (realtime-09).
 *
 * For each seated speaker's producer it opens a PlainTransport on the room's
 * source router and consumes the producer onto it (paused), pointing the RTP at
 * a local UDP port that FFmpeg will bind. `getInputs()` + `buildMixSdp()` then
 * describe all streams to FFmpeg, which mixes them (`HlsPublisher`).
 *
 * This is the *mixer's* half of the pipeline — it owns the mediasoup resources
 * and the SDP; it knows nothing about FFmpeg or HLS. The seam to `HlsPublisher`
 * is the SDP string + a "topology changed" return from `sync()`.
 *
 * ## Lifecycle / topology
 *  - `sync(producerIds)` diffs the desired seated-speaker set against the open
 *    transports, adding/removing as needed. It returns whether the set changed —
 *    the caller restarts FFmpeg only then (locked decision: self-mute does NOT
 *    change the set; the producer stays live via Opus DTX).
 *  - Consumers are created **paused**; `resumeAll()` is called once FFmpeg is
 *    listening so initial RTP isn't fired into a closed port.
 *
 * Ports: allocated from a small localhost pool (RTP only, rtcpMux), well clear of
 * the mediasoup WebRTC range; freed ports are reused.
 */
import type * as mediasoup from "mediasoup";
import type { Logger } from "pino";
import { buildMixSdp, type MixInput } from "./hls-pipeline.js";
import { reactError } from "@src/shared/react-error.js";

interface MixEntry {
  transport: mediasoup.types.PlainTransport;
  consumer: mediasoup.types.Consumer;
  port: number;
}

/** Default base port for FFmpeg RTP receive — clear of MEDIASOUP_RTC_MIN_PORT (10000). */
const DEFAULT_BASE_PORT = 5004;

export class SpeakerMixer {
  /** producerId → its plain transport + consumer + port. Insertion-ordered. */
  private readonly entries = new Map<string, MixEntry>();
  private readonly usedPorts = new Set<number>();

  constructor(
    private readonly router: mediasoup.types.Router,
    private readonly logger: Logger,
    private readonly basePort: number = DEFAULT_BASE_PORT,
  ) {}

  /** Current number of mixed speakers. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Reconcile the open transports to exactly `producerIds`. Adds transports for
   * new producers, removes those no longer seated. Returns true iff the set
   * changed (the caller should then (re)start FFmpeg with the new SDP).
   */
  async sync(producerIds: string[]): Promise<boolean> {
    const desired = new Set(producerIds);
    let changed = false;

    // Remove producers that left.
    for (const producerId of [...this.entries.keys()]) {
      if (!desired.has(producerId)) {
        this.remove(producerId);
        changed = true;
      }
    }

    // Add producers that joined.
    for (const producerId of producerIds) {
      if (!this.entries.has(producerId)) {
        const added = await this.add(producerId);
        if (added) changed = true;
      }
    }

    return changed;
  }

  /** Build the SDP for the current mix set (one m-line per speaker, in order). */
  getSdp(): string {
    return buildMixSdp(this.getInputs());
  }

  /** The current mix inputs, in stable insertion order (matches SDP m-line order). */
  getInputs(): MixInput[] {
    const inputs: MixInput[] = [];
    for (const { consumer, port } of this.entries.values()) {
      const codec = consumer.rtpParameters.codecs[0];
      if (!codec) continue;
      inputs.push({
        port,
        payloadType: codec.payloadType,
        clockRate: codec.clockRate,
        channels: codec.channels ?? 2,
      });
    }
    return inputs;
  }

  /** Resume all consumers — call once FFmpeg is bound and reading the SDP ports. */
  async resumeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(({ consumer }) =>
        consumer.resume().catch((err) =>
          reactError(err, {}, "SpeakerMixer: consumer resume failed", { logger: this.logger }),
        ),
      ),
    );
  }

  /** Close every transport (closes consumers) and free all ports. */
  close(): void {
    for (const producerId of [...this.entries.keys()]) {
      this.remove(producerId);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  private async add(producerId: string): Promise<boolean> {
    const port = this.allocatePort();
    try {
      const transport = await this.router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: "127.0.0.1" },
        rtcpMux: true,
        comedia: false,
      });
      // mediasoup is the sender; point its RTP at FFmpeg's local receive port.
      await transport.connect({ ip: "127.0.0.1", port });

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: true,
        appData: { broadcastMix: true },
      });

      this.entries.set(producerId, { transport, consumer, port });
      return true;
    } catch (err) {
      this.usedPorts.delete(port);
      this.logger.warn(
        { err, producerId, port },
        "SpeakerMixer: failed to add producer to mix",
      );
      return false;
    }
  }

  private remove(producerId: string): void {
    const entry = this.entries.get(producerId);
    if (!entry) return;
    if (!entry.transport.closed) entry.transport.close();
    this.usedPorts.delete(entry.port);
    this.entries.delete(producerId);
  }

  /** Lowest free even port at/above basePort (step 2 leaves room for RTCP). */
  private allocatePort(): number {
    let port = this.basePort;
    while (this.usedPorts.has(port)) port += 2;
    this.usedPorts.add(port);
    return port;
  }
}
