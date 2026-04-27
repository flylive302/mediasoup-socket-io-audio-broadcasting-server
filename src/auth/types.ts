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
  signature: z.string().default(""),
  email: z.string().nullable().default(""),
  avatar: z.string().nullable().default(""),
  frame: z.string().nullable().default(""),
  gender: z.coerce.number().default(0),
  date_of_birth: z.string().nullable().default(""), // ISO date string (YYYY-MM-DD) or empty
  phone: z.string().nullable().default(""),
  country: z.string().nullable().default(""),
  coins: z.string().default("0"),
  diamonds: z.string().default("0"),
  wealth_xp: z.string().default("0"),
  charm_xp: z.string().default("0"),
  is_blocked: z.boolean().default(false),
  vip_level: z.number().default(0),
  isSpeaker: z.boolean().default(false),
});

/** User type derived from Zod schema */
export type User = z.infer<typeof UserSchema>;

export interface AuthSocketData {
  user: User;
}
