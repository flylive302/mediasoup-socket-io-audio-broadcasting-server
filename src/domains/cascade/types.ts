/**
 * Cascade Types — Shared types for SFU cascade cross-region coordination
 */

// ─── Pipe Negotiation ───────────────────────────────────────────

/** Request body for POST /internal/pipe/offer */
export interface PipeOfferRequest {
  roomId: string;
  producerId: string;
  edgeIp: string;
  edgePort: number;
  edgeRtpCapabilities: import("mediasoup").types.RtpCapabilities;
}

/** Response from POST /internal/pipe/offer */
export interface PipeOfferResponse {
  status: string;
  transportId: string;
  ip: string;
  port: number;
  srtpParameters: unknown | null;
  rtpParameters: import("mediasoup").types.RtpParameters;
  kind: import("mediasoup").types.MediaKind;
}

// ─── Relay ──────────────────────────────────────────────────────

/** Payload relayed between instances for socket events */
export interface RelayPayload {
  roomId: string;
  event: string;
  data: unknown;
  sourceInstanceId: string;
}

// ─── Cascade Join ───────────────────────────────────────────────

/** Result of a cross-region cascade join attempt */
export interface CascadeJoinResult {
  isEdge: boolean;
  originIp?: string;
  originPort?: number;
  originRegion?: string;
}

/** Info about a remote instance participating in a room */
export interface RemoteInstance {
  instanceId: string;
  baseUrl: string;
}
