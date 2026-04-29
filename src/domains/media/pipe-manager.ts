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

  /**
   * Origin-side reverse-pipe inbound transports keyed by edge producerId.
   * Lets us close the right transport when an edge speaker disconnects
   * (POST /internal/pipe/reverse-close arrives with edgeProducerId).
   */
  private readonly reverseInboundByEdge = new Map<
    string,
    Map<string, { transport: mediasoup.types.PlainTransport; producer: mediasoup.types.Producer }>
  >();

  /**
   * Transports created in createReverseInboundTransport that have not yet
   * been finalize()d. Keyed by transportId so the finalize endpoint can
   * find the right one in a different request scope.
   */
  private readonly pendingReverseInbound = new Map<
    string,
    mediasoup.types.PlainTransport
  >();

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

  // ─── Reverse pipe (edge speaker → origin) ──────────────────────
  //
  // Mirrors the forward pattern but with edge as sender and origin as
  // receiver: edge consumes its local producer and sends RTP to origin;
  // origin produces with the consumer's rtpParameters so the SSRC/PT match.
  //
  // Two HTTP roundtrips are needed because origin must connect to edge
  // BEFORE edge can call consume() (so the edge's outbound transport has
  // a destination), and origin can't call produce() until it has the
  // consumer's rtpParameters from edge:
  //
  //   1. createReverseOutboundTransport (edge)            — listen for outbound
  //   2. POST /reverse-offer → createReverseInboundTransport (origin) — listen + connect to edge
  //   3. connectReverseTransport (edge)                    — connect + consume → consumer.rtpParameters
  //   4. POST /reverse-finalize → finalizeReverseInbound (origin) — produce + register with cluster

  /**
   * EDGE side, reverse phase 1: create the outbound plainTransport whose
   * listen address is sent to origin in the reverse-offer. Identical
   * mediasoup setup as the forward edge listener — we keep two methods
   * with distinct names so call sites read clearly (and so tracking maps
   * can diverge later if needed).
   */
  async createReverseOutboundTransport(
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

    this.trackTransport(roomId, transport);

    const tuple = transport.tuple;
    return {
      transport,
      ip: tuple.localAddress ?? "0.0.0.0",
      port: tuple.localPort,
    };
  }

  /**
   * EDGE side, reverse phase 3: connect outbound transport to origin's
   * address and consume the local producer using ORIGIN's rtpCapabilities
   * so the consumer's rtpParameters describe what origin can decode.
   * Origin produces with these rtpParameters in finalizeReverseInbound.
   */
  async connectReverseTransport(
    transport: mediasoup.types.PlainTransport,
    originAddress: { ip: string; port: number; srtpParameters?: mediasoup.types.SrtpParameters },
    localProducerId: string,
    originRtpCapabilities: mediasoup.types.RtpCapabilities,
    roomId: string,
  ): Promise<{
    consumer: mediasoup.types.Consumer;
    consumerRtpParameters: mediasoup.types.RtpParameters;
    consumerKind: mediasoup.types.MediaKind;
  }> {
    await transport.connect({
      ip: originAddress.ip,
      port: originAddress.port,
      ...(originAddress.srtpParameters
        ? { srtpParameters: originAddress.srtpParameters }
        : {}),
    });

    const consumer = await transport.consume({
      producerId: localProducerId,
      rtpCapabilities: originRtpCapabilities,
      paused: false,
    });

    this.logger.debug(
      {
        roomId,
        localProducerId,
        consumerId: consumer.id,
        originIp: originAddress.ip,
        originPort: originAddress.port,
      },
      "PipeManager: reverse outbound connected and consuming",
    );

    return {
      consumer,
      consumerRtpParameters: consumer.rtpParameters,
      consumerKind: consumer.kind,
    };
  }

  /**
   * ORIGIN side, reverse phase 2: create the inbound plainTransport, point
   * it at the edge's address, and return our listen address plus our
   * router's rtpCapabilities so the edge can consume against them.
   *
   * No produce() yet — that happens in finalizeReverseInbound once the
   * edge has sent us the consumer's rtpParameters.
   */
  async createReverseInboundTransport(
    router: mediasoup.types.Router,
    edgeAddress: { ip: string; port: number },
    roomId: string,
  ): Promise<{
    transport: mediasoup.types.PlainTransport;
    transportId: string;
    ip: string;
    port: number;
    rtpCapabilities: mediasoup.types.RtpCapabilities;
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

    await transport.connect({
      ip: edgeAddress.ip,
      port: edgeAddress.port,
    });

    this.trackTransport(roomId, transport);
    this.pendingReverseInbound.set(transport.id, transport);

    const tuple = transport.tuple;
    this.logger.debug(
      {
        roomId,
        transportId: transport.id,
        ip: tuple.localAddress,
        port: tuple.localPort,
        edgeIp: edgeAddress.ip,
        edgePort: edgeAddress.port,
      },
      "PipeManager: reverse inbound created and connected to edge",
    );

    return {
      transport,
      transportId: transport.id,
      ip: tuple.localAddress ?? "0.0.0.0",
      port: tuple.localPort,
      rtpCapabilities: router.rtpCapabilities,
    };
  }

  /**
   * ORIGIN side, reverse phase 4: produce on the inbound transport using
   * the edge consumer's rtpParameters. The producer is registered with
   * origin's cluster (which auto-pipes to dist routers and triggers
   * audio:newProducer relay to all edges, including back to the originating
   * edge — the relay handler must filter that bounce to avoid pipe loops).
   *
   * Returns the resulting producer's id so the edge can store the mapping
   * for cleanup signaling.
   */
  async finalizeReverseInbound(
    transportId: string,
    edgeProducerId: string,
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
    appData: Record<string, unknown>,
    roomId: string,
  ): Promise<{
    transport: mediasoup.types.PlainTransport;
    producer: mediasoup.types.Producer;
  }> {
    const transport = this.pendingReverseInbound.get(transportId);
    if (!transport) {
      throw new Error(
        `PipeManager: pending reverse inbound transport ${transportId} not found (already finalized or expired?)`,
      );
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData,
    });

    this.pendingReverseInbound.delete(transportId);

    let perRoom = this.reverseInboundByEdge.get(roomId);
    if (!perRoom) {
      perRoom = new Map();
      this.reverseInboundByEdge.set(roomId, perRoom);
    }
    perRoom.set(edgeProducerId, { transport, producer });

    // If origin's transport closes (mediasoup teardown, room close, etc.)
    // remove our index entry so a subsequent reverse-close is a no-op.
    transport.observer.on("close", () => {
      this.reverseInboundByEdge.get(roomId)?.delete(edgeProducerId);
      if (this.reverseInboundByEdge.get(roomId)?.size === 0) {
        this.reverseInboundByEdge.delete(roomId);
      }
    });

    this.logger.info(
      {
        roomId,
        transportId,
        edgeProducerId,
        originProducerId: producer.id,
      },
      "PipeManager: reverse inbound producer created on origin",
    );

    return { transport, producer };
  }

  /**
   * ORIGIN side cleanup: close the inbound transport associated with an
   * edge producer. Closing the transport closes its producer (via
   * mediasoup's transportclose), which propagates audio:producerClosed
   * out via existing forward pipes.
   *
   * Handles both states cleanly so a partial-setup failure (offer succeeded,
   * finalize never came) doesn't leak the UDP port until room cleanup:
   *
   *   1. transportId provided → close pending (pre-finalize) or live (post-finalize)
   *   2. transportId missing  → fall back to edgeProducerId in the post-finalize map
   */
  async closeReverseInboundByEdgeProducer(
    roomId: string,
    edgeProducerId: string,
    transportId?: string,
  ): Promise<boolean> {
    if (transportId) {
      const pending = this.pendingReverseInbound.get(transportId);
      if (pending) {
        this.pendingReverseInbound.delete(transportId);
        try {
          pending.close();
        } catch {
          /* already closed */
        }
        return true;
      }
    }

    const entry = this.reverseInboundByEdge.get(roomId)?.get(edgeProducerId);
    if (!entry) return false;
    try {
      entry.transport.close();
    } catch {
      // transport may already be closed
    }
    return true;
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
