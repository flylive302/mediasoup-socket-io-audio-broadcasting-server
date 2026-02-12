/**
 * User data structure with runtime validation
 * Zod schema is the source of truth; TypeScript type is derived from it
 */
import { z } from "zod";

/**
 * Zod schema for validating user data from JWT payload or API responses.
 * All fields must match what Laravel embeds in the JWT.
 */
export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  signature: z.string(),
  email: z.string(),
  avatar: z.string(),
  frame: z.string(),
  gender: z.number(),
  date_of_birth: z.string(), // ISO date string (YYYY-MM-DD)
  phone: z.string(),
  country: z.string(),
  coins: z.string(),
  diamonds: z.string(),
  wealth_xp: z.string(),
  charm_xp: z.string(),
  is_blocked: z.boolean(),
  isSpeaker: z.boolean(),
});

/** User type derived from Zod schema */
export type User = z.infer<typeof UserSchema>;

export interface AuthSocketData {
  user: User;
}
