import * as mediasoup from "mediasoup";
import type { Logger } from "../../infrastructure/logger.js";
import { mediasoupConfig } from "../../config/mediasoup.js";

export class RouterManager {
  public router: mediasoup.types.Router | null = null;
  public audioObserver: mediasoup.types.ActiveSpeakerObserver | null = null;
  public readonly worker: mediasoup.types.Worker;

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
  ) {
    this.worker = worker;
  }

  async initialize(): Promise<void> {
    if (this.router) return;

    this.logger.debug("Creating room router");

    this.router = await this.worker.createRouter({
      mediaCodecs: mediasoupConfig.router.mediaCodecs,
    });

    this.audioObserver = await this.router.createActiveSpeakerObserver(
      mediasoupConfig.activeSpeakerObserver,
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

    const transport = await this.router.createWebRtcTransport({
      ...mediasoupConfig.webRtcTransport,
      appData: { isProducer },
    });

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

  registerConsumer(consumer: mediasoup.types.Consumer) {
    this.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => this.consumers.delete(consumer.id));
    consumer.on("producerclose", () => this.consumers.delete(consumer.id));
  }

  /**
   * Find a producer by ID.
   */
  getProducer(producerId: string): mediasoup.types.Producer | undefined {
    return this.producers.get(producerId);
  }

  registerProducer(producer: mediasoup.types.Producer) {
    this.producers.set(producer.id, producer);
    producer.on("transportclose", () => this.producers.delete(producer.id));
  }
}
