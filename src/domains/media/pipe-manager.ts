/**
 * Pipe Manager — plainTransport lifecycle for SFU cascade
 *
 * Manages the creation and teardown of mediasoup plainTransports
 * used to relay audio between origin and edge instances.
 *
 * Port range: 40000–49999 (distinct from WebRTC range 10000–59999)
 */
import * as mediasoup from "mediasoup";
import type { Logger } from "@src/infrastructure/logger.js";

const PLAIN_TRANSPORT_MIN_PORT = 40000;
const PLAIN_TRANSPORT_MAX_PORT = 49999;

export interface PlainTransportInfo {
  transportId: string;
  ip: string;
  port: number;
  srtpParameters?: mediasoup.types.SrtpParameters;
}

export class PipeManager {
  /** roomId → transports created for that room's pipes */
  private readonly roomPipes = new Map<string, mediasoup.types.PlainTransport[]>();

  constructor(private readonly logger: Logger) {}

  /**
   * ORIGIN side: create a plainTransport to send a producer's RTP out.
   *
   * The origin creates this transport, then gives the ip/port to the edge
   * via the internal API so the edge can `connect()` its own transport to it.
   */
  async createOriginPipe(
    router: mediasoup.types.Router,
    producerId: string,
    roomId: string,
  ): Promise<PlainTransportInfo> {
    const transport = await router.createPlainTransport({
      listenInfo: {
        protocol: "udp",
        ip: "0.0.0.0",
        portRange: {
          min: PLAIN_TRANSPORT_MIN_PORT,
          max: PLAIN_TRANSPORT_MAX_PORT,
        },
      },
      rtcpMux: true,
      comedia: false, // origin provides explicit remote address
    });

    // Consume the producer on this transport so RTP flows out
    await transport.consume({
      producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
    });

    // Track for cleanup
    this.trackTransport(roomId, transport);

    const tuple = transport.tuple;

    this.logger.debug(
      {
        roomId,
        producerId,
        transportId: transport.id,
        ip: tuple.localAddress,
        port: tuple.localPort,
      },
      "PipeManager: origin pipe created",
    );

    const info: PlainTransportInfo = {
      transportId: transport.id,
      ip: tuple.localAddress ?? "0.0.0.0",
      port: tuple.localPort,
    };
    if (transport.srtpParameters) {
      info.srtpParameters = transport.srtpParameters;
    }
    return info;
  }

  /**
   * EDGE side: create a plainTransport pointing at the origin's ip:port
   * and produce locally so edge listeners can consume.
   */
  async createEdgePipe(
    router: mediasoup.types.Router,
    originInfo: PlainTransportInfo,
    rtpParameters: mediasoup.types.RtpParameters,
    roomId: string,
  ): Promise<{
    transport: mediasoup.types.PlainTransport;
    producer: mediasoup.types.Producer;
  }> {
    const transport = await router.createPlainTransport({
      listenInfo: {
        protocol: "udp",
        ip: "0.0.0.0",
        portRange: {
          min: PLAIN_TRANSPORT_MIN_PORT,
          max: PLAIN_TRANSPORT_MAX_PORT,
        },
      },
      rtcpMux: true,
      comedia: false,
    });

    // Connect to origin's ip:port
    await transport.connect({
      ip: originInfo.ip,
      port: originInfo.port,
      ...(originInfo.srtpParameters
        ? { srtpParameters: originInfo.srtpParameters }
        : {}),
    });

    // Produce locally — edge listeners consume from this producer
    const producer = await transport.produce({
      kind: "audio",
      rtpParameters,
    });

    // Track for cleanup
    this.trackTransport(roomId, transport);

    this.logger.debug(
      {
        roomId,
        transportId: transport.id,
        producerId: producer.id,
        originIp: originInfo.ip,
        originPort: originInfo.port,
      },
      "PipeManager: edge pipe created",
    );

    return { transport, producer };
  }

  /** Close all pipe transports for a room */
  async closePipes(roomId: string): Promise<void> {
    const transports = this.roomPipes.get(roomId);
    if (!transports || transports.length === 0) return;

    for (const transport of transports) {
      try {
        transport.close();
      } catch {
        // Transport may already be closed
      }
    }

    this.roomPipes.delete(roomId);
    this.logger.debug(
      { roomId, closedCount: transports.length },
      "PipeManager: all pipes closed for room",
    );
  }

  /** Get count of active pipe transports for a room */
  getPipeCount(roomId: string): number {
    return this.roomPipes.get(roomId)?.length ?? 0;
  }

  // ─── Private ────────────────────────────────────────────────────

  private trackTransport(
    roomId: string,
    transport: mediasoup.types.PlainTransport,
  ): void {
    let list = this.roomPipes.get(roomId);
    if (!list) {
      list = [];
      this.roomPipes.set(roomId, list);
    }
    list.push(transport);

    // Auto-remove on transport close
    transport.observer.on("close", () => {
      const pipes = this.roomPipes.get(roomId);
      if (pipes) {
        const idx = pipes.indexOf(transport);
        if (idx !== -1) pipes.splice(idx, 1);
        if (pipes.length === 0) this.roomPipes.delete(roomId);
      }
    });
  }
}
