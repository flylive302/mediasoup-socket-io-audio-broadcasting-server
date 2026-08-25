/**
 * User data structure with runtime validation
 * Zod schema is the source of truth; TypeScript type is derived from it
 */
import { z } from "zod";
import type { RollingWindow } from "@src/shared/rollingWindow.js";

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
  frame_id: z.number().nullable().default(null),
  chat_bubble_id: z.number().nullable().default(null),
  entry_animation_id: z.number().nullable().default(null),
  data_card_id: z.number().nullable().default(null),
  mice_wave_id: z.number().nullable().default(null),
  slides_id: z.number().nullable().default(null),
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
  badge_slot_limit: z.number().default(6),
  equipped_badges: z
    .array(
      z.object({
        slot_position: z.number().int(),
        badge_id: z.number().int(),
        image_url: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

/** User type derived from Zod schema */
export type User = z.infer<typeof UserSchema>;

export interface AuthSocketData {
  user: User;

  /**
   * Correlation identifier supplied at the socket handshake, or minted by
   * `authMiddleware` (via `resolveCorrelationId`) when none was supplied or the
   * supplied value failed validation. Always set once authentication succeeds
   * (ticket 10). `createHandler`/`createSimpleHandler` read it and bind it as the
   * ambient identifier for every invocation on this socket.
   */
  correlationId?: string;

  /**
   * Number of `gift:send` events accepted on this socket. Emitted with the
   * disconnect log so a "ping timeout" can be tied to a gift combo directly
   * (gift-burst-ping-timeout, 2026-08-22) — MSAB logs no per-gift line, so
   * this counter is the only correlation signal.
   */
  giftSendCount?: number;

  /**
   * gift-authority-tick-fanout 01: trailing 60 s bucketed count of gifts sent
   * by (accepted `gift:send`) or delivered to (any `gift:*` outgoing event
   * except `gift:error`) this socket. Read at disconnect as `giftsLast60s` —
   * a rate rather than the cumulative `giftSendCount` above, so a "ping
   * timeout" after a burst that ended minutes earlier doesn't look like a
   * live storm.
   */
  giftActivityWindow?: RollingWindow;

  /**
   * gift-authority-tick-fanout 01: trailing 10 s bucketed count of every
   * server→this-socket outgoing event (room broadcasts included). Read at
   * disconnect as `inboundMsgsPerSec` (count / 10, 2dp) — the fan-out load
   * this socket was under just before it dropped.
   */
  inboundActivityWindow?: RollingWindow;
}
