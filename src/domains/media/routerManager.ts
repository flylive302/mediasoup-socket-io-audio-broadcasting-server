import * as mediasoup from "mediasoup";
import type { Logger } from "@src/infrastructure/logger.js";
import { mediasoupConfig } from "@src/config/mediasoup.js";
import {
  observeConsumerQuality,
  observeProducerQuality,
} from "./quality/scoreObservers.js";
import type { ClientLeg } from "./quality/scoreRegistry.js";

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

    if (clientLeg) observeConsumerQuality(consumer, clientLeg);
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

    if (clientLeg) observeProducerQuality(producer, clientLeg);
  }
}
