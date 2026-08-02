import * as mediasoup from "mediasoup";
import type { Logger } from "@src/infrastructure/logger.js";
import { mediasoupConfig } from "@src/config/mediasoup.js";
import {
  observeConsumerQuality,
  observeProducerQuality,
} from "./quality/scoreObservers.js";
import type { ClientLeg } from "./quality/scoreRegistry.js";
import type { QualityDirection } from "./quality/qualityAggregator.js";

/**
 * One live client leg, ready for ticket 02's statistics sweep.
 *
 * The sweep needs the mediasoup handle (only it can answer `getStats()`) plus
 * the identity the handle does not carry. Relay and egress legs never produce
 * one of these — see `listClientLegs`.
 */
export interface ClientLegHandle {
  readonly streamId: string;
  readonly direction: QualityDirection;
  readonly leg: ClientLeg;
  readonly stream: mediasoup.types.Consumer | mediasoup.types.Producer;
}

export class RouterManager {
  public router: mediasoup.types.Router | null = null;
  public audioObserver: mediasoup.types.AudioLevelObserver | null = null;
  public readonly worker: mediasoup.types.Worker;
  private readonly webRtcServer: mediasoup.types.WebRtcServer | null;

  // Store transports for lookups during connect/produce/consume
  private readonly transports = new Map<
    string,
    mediasoup.types.WebRtcTransport
  >();
  // Track consumers for resume/close
  private readonly consumers = new Map<string, mediasoup.types.Consumer>();
  // Track producers for mute/close
  private readonly producers = new Map<string, mediasoup.types.Producer>();

  // observability-audio-quality 02: which registered streams belong to a real
  // participant. Default-deny — a stream is absent unless its caller passed an
  // explicit ClientLeg, exactly as ticket 01 decided. Torn down on
  // `observer.on("close")`, the only close path that fires everywhere.
  private readonly clientLegs = new Map<string, ClientLeg>();



  constructor(
    worker: mediasoup.types.Worker,
    private readonly logger: Logger,
    webRtcServer: mediasoup.types.WebRtcServer | null = null,
  ) {
    this.worker = worker;
    this.webRtcServer = webRtcServer;
  }

  async initialize(): Promise<void> {
    if (this.router) return;

    this.logger.debug("Creating room router");

    this.router = await this.worker.createRouter({
      mediaCodecs: mediasoupConfig.router.mediaCodecs,
    });

    this.audioObserver = await this.router.createAudioLevelObserver(
      mediasoupConfig.audioLevelObserver,
    );
  }



  async close(): Promise<void> {
    this.transports.forEach((t) => t.close());
    this.transports.clear();
    this.consumers.clear();
    this.producers.clear();
    this.clientLegs.clear();

    if (this.audioObserver) {
      this.audioObserver.close();
      this.audioObserver = null;
    }

    if (this.router) {
      this.router.close();
      this.router = null;
    }
  }

  async createWebRtcTransport(
    isProducer: boolean,
  ): Promise<mediasoup.types.WebRtcTransport> {
    if (!this.router) throw new Error("Router not initialized");

    // Prefer WebRtcServer (shared port) over per-transport port allocation
    const outgoingBitrate =
      mediasoupConfig.webRtcTransport.initialAvailableOutgoingBitrate;

    const transportOptions: mediasoup.types.WebRtcTransportOptions = this
      .webRtcServer
      ? {
          webRtcServer: this.webRtcServer,
          ...(outgoingBitrate
            ? { initialAvailableOutgoingBitrate: outgoingBitrate }
            : {}),
          appData: { isProducer },
        }
      : {
          ...mediasoupConfig.webRtcTransport,
          appData: { isProducer },
        };

    const transport =
      await this.router.createWebRtcTransport(transportOptions);

    // Apply max incoming bitrate limit (set via API, not constructor option)
    if (mediasoupConfig.maxIncomingBitrate) {
      await transport.setMaxIncomingBitrate(
        mediasoupConfig.maxIncomingBitrate,
      );
    }

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") transport.close();
    });

    this.transports.set(transport.id, transport);

    return transport;
  }

  getTransport(
    transportId: string,
  ): mediasoup.types.WebRtcTransport | undefined {
    return this.transports.get(transportId);
  }

  /**
   * Find a consumer by ID.
   */
  getConsumer(consumerId: string): mediasoup.types.Consumer | undefined {
    return this.consumers.get(consumerId);
  }

  /**
   * @param clientLeg pass ONLY for a real participant leg — a browser being
   * served audio. Omitting it excludes the consumer from audio-quality
   * sampling (observability-audio-quality 01). Default-deny: a relay or
   * egress consumer that is later routed through here stays out of the
   * metric unless someone deliberately opts it in.
   */
  registerConsumer(
    consumer: mediasoup.types.Consumer,
    clientLeg?: ClientLeg,
  ) {
    this.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => this.consumers.delete(consumer.id));
    consumer.on("producerclose", () => this.consumers.delete(consumer.id));

    if (clientLeg) {
      this.clientLegs.set(consumer.id, clientLeg);
      consumer.observer.on("close", () => this.clientLegs.delete(consumer.id));
      observeConsumerQuality(consumer, clientLeg);
    }
  }

  /**
   * Find a producer by ID.
   */
  getProducer(producerId: string): mediasoup.types.Producer | undefined {
    return this.producers.get(producerId);
  }

  /**
   * @param clientLeg pass ONLY for a real participant leg — a mic or music
   * producer created on that participant's own transport. The two relay
   * registration sites (`api/internal.ts` reverse-pipe finalize and
   * `cascade/edge-pipe-lifecycle.ts` forward-pipe) deliberately omit it, so
   * pipe legs never enter the audio-quality metric.
   */
  registerProducer(
    producer: mediasoup.types.Producer,
    clientLeg?: ClientLeg,
  ) {
    this.producers.set(producer.id, producer);
    producer.on("transportclose", () => this.producers.delete(producer.id));

    if (clientLeg) {
      this.clientLegs.set(producer.id, clientLeg);
      producer.observer.on("close", () => this.clientLegs.delete(producer.id));
      observeProducerQuality(producer, clientLeg);
    }
  }

  /**
   * Read-only enumeration of the live consumer set. The map itself stays
   * private; this is a copied array.
   *
   * ⚠️ CLOSED HANDLES ARE FILTERED, and that is not defensive tidiness.
   * Registration only wires `transportclose` (and `producerclose` for
   * consumers), so a bare `producer.close()` — `media.handler.ts:267` and
   * `:535`, `shared/producer-cleanup.ts:47` — leaves a closed handle in the
   * map forever. `getStats()` on a closed handle rejects, so an unfiltered
   * enumeration would make the statistics sweep noisier the longer the
   * process lives. This is the same class of bug as ticket 01's decision #2.
   */
  listConsumers(): mediasoup.types.Consumer[] {
    return [...this.consumers.values()].filter((consumer) => !consumer.closed);
  }

  /** Read-only enumeration of the live producer set. See `listConsumers`. */
  listProducers(): mediasoup.types.Producer[] {
    return [...this.producers.values()].filter((producer) => !producer.closed);
  }

  /**
   * The live legs belonging to real participants, ready to be swept.
   *
   * Default-deny: a stream appears only if its registration passed a
   * `ClientLeg`. The cross-region relay legs (`api/internal.ts` reverse-pipe
   * finalize, `cascade/edge-pipe-lifecycle.ts` forward-pipe) register without
   * one and are therefore invisible here — deliberately, because a percentile
   * that silently mixed relay traffic into participant traffic would be worse
   * than no percentile at all.
   */
  listClientLegs(): ClientLegHandle[] {
    const handles: ClientLegHandle[] = [];

    for (const producer of this.listProducers()) {
      const leg = this.clientLegs.get(producer.id);
      if (leg) {
        handles.push({
          streamId: producer.id,
          direction: "sending",
          leg,
          stream: producer,
        });
      }
    }

    for (const consumer of this.listConsumers()) {
      const leg = this.clientLegs.get(consumer.id);
      if (leg) {
        handles.push({
          streamId: consumer.id,
          direction: "receiving",
          leg,
          stream: consumer,
        });
      }
    }

    return handles;
  }
}
