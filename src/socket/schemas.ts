import { z } from "zod";

// Reusable validators
// roomId accepts both numeric IDs ("1", "42") and UUIDs for flexibility with Laravel backend
const roomIdSchema = z.string().min(1);

// ─────────────────────────────────────────────────────────────────
// Mediasoup Parameter Schemas
// ─────────────────────────────────────────────────────────────────

/**
 * DTLS fingerprint schema
 * Used in DTLS handshake for secure connections
 */
const dtlsFingerprintSchema = z.object({
  algorithm: z.string(),
  value: z.string(),
});

/**
 * DTLS parameters for WebRTC transport connection
 * https://mediasoup.org/documentation/v3/mediasoup/api/#DtlsParameters
 */
const dtlsParametersSchema = z.object({
  role: z.enum(["auto", "client", "server"]).optional(),
  fingerprints: z.array(dtlsFingerprintSchema),
});

/**
 * RTP codec parameters
 */
const rtpCodecParametersSchema = z.object({
  mimeType: z.string(),
  payloadType: z.number().int(),
  clockRate: z.number().int(),
  channels: z.number().int().optional(),
  parameters: z.record(z.unknown()).optional(),
  rtcpFeedback: z.array(z.object({
    type: z.string(),
    parameter: z.string().optional(),
  })).optional(),
});

/**
 * RTP header extension
 */
const rtpHeaderExtensionSchema = z.object({
  uri: z.string(),
  id: z.number().int(),
  encrypt: z.boolean().optional(),
  parameters: z.record(z.unknown()).optional(),
});

/**
 * RTP encoding parameters
 */
const rtpEncodingParameterSchema = z.object({
  ssrc: z.number().int().optional(),
  rid: z.string().optional(),
  codecPayloadType: z.number().int().optional(),
  rtx: z.object({ ssrc: z.number().int() }).optional(),
  dtx: z.boolean().optional(),
  scalabilityMode: z.string().optional(),
  scaleResolutionDownBy: z.number().optional(),
  maxBitrate: z.number().int().optional(),
});

/**
 * RTCP parameters
 */
const rtcpParametersSchema = z.object({
  cname: z.string().optional(),
  reducedSize: z.boolean().optional(),
  mux: z.boolean().optional(),
});

/**
 * RTP parameters for producing media
 * https://mediasoup.org/documentation/v3/mediasoup/api/#RtpParameters
 */
const rtpParametersSchema = z.object({
  mid: z.string().optional(),
  codecs: z.array(rtpCodecParametersSchema),
  headerExtensions: z.array(rtpHeaderExtensionSchema).optional(),
  encodings: z.array(rtpEncodingParameterSchema).optional(),
  rtcp: rtcpParametersSchema.optional(),
});

/**
 * RTP codec capability
 */
const rtpCodecCapabilitySchema = z.object({
  kind: z.enum(["audio", "video"]),
  mimeType: z.string(),
  preferredPayloadType: z.number().int().optional(),
  clockRate: z.number().int(),
  channels: z.number().int().optional(),
  parameters: z.record(z.unknown()).optional(),
  rtcpFeedback: z.array(z.object({
    type: z.string(),
    parameter: z.string().optional(),
  })).optional(),
});

/**
 * RTP header extension capability
 */
const rtpHeaderExtensionCapabilitySchema = z.object({
  kind: z.enum(["audio", "video"]),
  uri: z.string(),
  preferredId: z.number().int(),
  preferredEncrypt: z.boolean().optional(),
  direction: z.enum(["sendrecv", "sendonly", "recvonly", "inactive"]).optional(),
});

/**
 * RTP capabilities for consuming media
 * https://mediasoup.org/documentation/v3/mediasoup/api/#RtpCapabilities
 */
const rtpCapabilitiesSchema = z.object({
  codecs: z.array(rtpCodecCapabilitySchema),
  headerExtensions: z.array(rtpHeaderExtensionCapabilitySchema).optional(),
});

// ─────────────────────────────────────────────────────────────────
// Transport Schemas
// ─────────────────────────────────────────────────────────────────

export const transportCreateSchema = z.object({
  type: z.enum(["producer", "consumer"]),
  roomId: roomIdSchema,
});

export const transportConnectSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  dtlsParameters: dtlsParametersSchema,
});

export const audioProduceSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  kind: z.enum(["audio"]), // Only audio supported
  rtpParameters: rtpParametersSchema,
});

export const audioConsumeSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  producerId: z.string().uuid(),
  rtpCapabilities: rtpCapabilitiesSchema,
});

// ─────────────────────────────────────────────────────────────────
// Room Schemas
// ─────────────────────────────────────────────────────────────────

export const lockedSeatsSchema = z.array(z.number());

export const joinRoomSchema = z.object({
  roomId: z.string(),
  ownerId: z.number().optional(), // Owner ID sent from frontend to verify ownership
});

export const leaveRoomSchema = z.object({
  roomId: roomIdSchema,
});

// ─────────────────────────────────────────────────────────────────
// Chat Schemas
// ─────────────────────────────────────────────────────────────────

export const chatMessageSchema = z.object({
  roomId: roomIdSchema,
  content: z.string().min(1).max(500), // Max length
  type: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────
// Gift Schemas
// ─────────────────────────────────────────────────────────────────

export const sendGiftSchema = z.object({
  roomId: roomIdSchema,
  giftId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
});

// ─────────────────────────────────────────────────────────────────
// Consumer Schemas
// ─────────────────────────────────────────────────────────────────

export const consumerResumeSchema = z.object({
  roomId: roomIdSchema,
  consumerId: z.string().uuid(),
});

// ─────────────────────────────────────────────────────────────────
// Seat Management Schemas
// ─────────────────────────────────────────────────────────────────

export const seatTakeSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14), // 0-14 for 15 seats
});

export const seatLeaveSchema = z.object({
  roomId: roomIdSchema,
});

export const seatAssignSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  seatIndex: z.number().int().min(0).max(14),
});

export const seatRemoveSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
});

export const seatMuteSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
});

export const seatLockSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14),
});

export const seatInviteSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  seatIndex: z.number().int().min(0).max(14),
});

export const seatInviteResponseSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14),
  accept: z.boolean(),
});

// Schema for seat:invite:accept and seat:invite:decline
// seatIndex is optional - if not provided, server looks up the pending invite by userId
export const seatInviteActionSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14).optional(),
});

