import { z } from 'zod';

export const transportCreateSchema = z.object({
  type: z.enum(['producer', 'consumer']),
  roomId: z.string().uuid(),
});

export const transportConnectSchema = z.object({
  roomId: z.string().uuid(),
  transportId: z.string().uuid(),
  dtlsParameters: z.object({}).passthrough(),
});

export const audioProduceSchema = z.object({
  roomId: z.string().uuid(),
  transportId: z.string().uuid(),
  kind: z.enum(['audio']), // Only audio supported
  rtpParameters: z.object({}).passthrough(), // Allow any valid RTP parameters
});

export const audioConsumeSchema = z.object({
  roomId: z.string().uuid(),
  transportId: z.string().uuid(),
  producerId: z.string().uuid(),
  rtpCapabilities: z.object({}).passthrough(),
});

export const joinRoomSchema = z.object({
  roomId: z.string().uuid(),
});

export const chatMessageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().min(1).max(500), // Max length
  type: z.string().optional(),
});

export const sendGiftSchema = z.object({
  roomId: z.string().uuid(),
  giftId: z.string().uuid(),
  recipientId: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
});

export const leaveRoomSchema = z.object({
  roomId: z.string().uuid(),
});

export const consumerResumeSchema = z.object({
  roomId: z.string().uuid(),
  consumerId: z.string().uuid(),
});
