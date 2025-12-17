/**
 * Seat Domain Zod Schemas 
 * Validation schemas for seat-related socket events
 */
import { z } from "zod";

// Reusable roomId validator
const roomIdSchema = z.string().min(1);

// seat:take - User takes an available seat
export const seatTakeSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14), // 0-14 for 15 seats
});

// seat:leave - User leaves their seat
export const seatLeaveSchema = z.object({
  roomId: roomIdSchema,
});

// seat:assign - Owner assigns user to specific seat
export const seatAssignSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  seatIndex: z.number().int().min(0).max(14),
});

// seat:remove - Owner removes user from seat
export const seatRemoveSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
});

// seat:mute / seat:unmute - Owner mutes/unmutes user
export const seatMuteSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
});

// seat:lock / seat:unlock - Owner locks/unlocks seat
export const seatLockSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14),
});

// seat:invite - Owner invites user to seat
export const seatInviteSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  seatIndex: z.number().int().min(0).max(14),
});

// seat:invite:response - User accepts or rejects invite (legacy)
export const seatInviteResponseSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14),
  accept: z.boolean(),
});

// seat:invite:accept / seat:invite:decline - Frontend event format
// seatIndex is optional - if not provided, server looks up by userId
export const seatInviteActionSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(14).optional(),
});
