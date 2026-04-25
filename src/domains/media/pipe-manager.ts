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
   * ORIGIN side: create a plainTransport, point it at the edge's address,
   * then consume the producer using the EDGE'S rtpCapabilities so RTP flows
   * OUT to the edge with parameters the edge can decode.
   *
   * Per mediasoup v3 docs ("Consuming Media in an External Endpoint"):
   * the consumer must be created with the receiver's rtpCapabilities, and
   * the receiver produces using the resulting consumer.rtpParameters — that
   * carries the negotiated payload type, SSRC, header extensions, etc.
   * Synthesizing rtpParameters on the receiver causes SSRC mismatch and the
   * producer never sees incoming packets.
   *
   * Returns the consumer's rtpParameters/kind so the edge can produce with
   * the exact same SSRC/PT the origin is sending.
   */
  async createOriginPipe(
    router: mediasoup.types.Router,
    producerId: string,
    roomId: string,
    edgeAddress: { ip: string; port: number },
    edgeRtpCapabilities: mediasoup.types.RtpCapabilities,
  ): Promise<PlainTransportInfo & {
    consumerRtpParameters: mediasoup.types.RtpParameters;
    consumerKind: mediasoup.types.MediaKind;
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
      comedia: false, // origin provides explicit remote address
    });

    // Connect to edge BEFORE consuming so RTP has a destination from the
    // first packet — order matters: consume() against an unconnected
    // transport silently produces packets that go nowhere.
    await transport.connect({
      ip: edgeAddress.ip,
      port: edgeAddress.port,
    });

    // Consume with the EDGE's caps so the consumer's rtpParameters reflect
    // what the edge can decode. The returned rtpParameters carry SSRC, PT,
    // and header extensions that the edge MUST mirror in produce().
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: edgeRtpCapabilities,
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
        consumerId: consumer.id,
        ip: tuple.localAddress,
        port: tuple.localPort,
        edgeIp: edgeAddress.ip,
        edgePort: edgeAddress.port,
      },
      "PipeManager: origin pipe created",
    );

    const info: PlainTransportInfo & {
      consumerRtpParameters: mediasoup.types.RtpParameters;
      consumerKind: mediasoup.types.MediaKind;
    } = {
      transportId: transport.id,
      ip: tuple.localAddress ?? "0.0.0.0",
      port: tuple.localPort,
      consumerRtpParameters: consumer.rtpParameters,
      consumerKind: consumer.kind,
    };
    if (transport.srtpParameters) {
      info.srtpParameters = transport.srtpParameters;
    }
    return info;
  }

  /**
   * EDGE side, phase 1: create the local plainTransport and return its
   * listen address so the edge can POST it to the origin's /pipe/offer
   * before the origin creates its own end. The transport is NOT yet
   * connected or producing — call createEdgePipeFromTransport with the
   * origin's returned address to complete setup.
   */
  async createEdgeListener(
    router: mediasoup.types.Router,
    roomId: string,
  ): Promise<{ transport: mediasoup.types.PlainTransport; ip: string; port: number }> {
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

    // Track immediately so close-on-error paths still clean up.
    this.trackTransport(roomId, transport);

    const tuple = transport.tuple;
    return {
      transport,
      ip: tuple.localAddress ?? "0.0.0.0",
      port: tuple.localPort,
    };
  }

  /**
   * EDGE side, phase 2: connect a previously-created edge listener transport
   * to the origin's address and produce locally so edge listeners can consume.
   *
   * Split from createEdgeListener so we can give the origin our local address
   * BEFORE it consumes — the origin needs that address to know where to send
   * RTP (comedia is disabled on both ends).
   */
  async createEdgePipeFromTransport(
    transport: mediasoup.types.PlainTransport,
    originInfo: PlainTransportInfo,
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
    roomId: string,
  ): Promise<{
    transport: mediasoup.types.PlainTransport;
    producer: mediasoup.types.Producer;
  }> {
    // Connect to origin's ip:port
    await transport.connect({
      ip: originInfo.ip,
      port: originInfo.port,
      ...(originInfo.srtpParameters
        ? { srtpParameters: originInfo.srtpParameters }
        : {}),
    });

    // Produce locally with the origin consumer's rtpParameters — these carry
    // the SSRC and PT that origin is sending, which the producer must match
    // for incoming RTP to bind correctly.
    const producer = await transport.produce({
      kind,
      rtpParameters,
    });

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
