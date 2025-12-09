import { z } from 'zod';

// Reusable validators
// roomId accepts both numeric IDs ("1", "42") and UUIDs for flexibility with Laravel backend
const roomIdSchema = z.string().min(1);

export const transportCreateSchema = z.object({
  type: z.enum(['producer', 'consumer']),
  roomId: roomIdSchema,
});

export const transportConnectSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  dtlsParameters: z.object({}).passthrough(),
});

export const audioProduceSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  kind: z.enum(['audio']), // Only audio supported
  rtpParameters: z.object({}).passthrough(), // Allow any valid RTP parameters
});

export const audioConsumeSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  producerId: z.string().uuid(),
  rtpCapabilities: z.object({}).passthrough(),
});

export const joinRoomSchema = z.object({
  roomId: roomIdSchema,
});

export const chatMessageSchema = z.object({
  roomId: roomIdSchema,
  content: z.string().min(1).max(500), // Max length
  type: z.string().optional(),
});

export const sendGiftSchema = z.object({
  roomId: roomIdSchema,
  giftId: z.number().int().positive(), // Changed from UUID string to number per backend protocol
  recipientId: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
});

export const leaveRoomSchema = z.object({
  roomId: roomIdSchema,
});

export const consumerResumeSchema = z.object({
  roomId: roomIdSchema,
  consumerId: z.string().uuid(),
});

// Seat management schemas
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
