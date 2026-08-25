/**
 * gift-authority-tick-fanout 12 — pure GATE: may this user send this gift?
 * Mirrors the backend's sendability rules on the room server so a refusal
 * happens before the room ever sees the tap. No I/O; every input is passed in.
 */
import type { CachedGift } from "./catalogCache.js";

/** Machine-readable refusal codes carried on the `gift:send` ack. */
export const GiftRefusal = {
  INSUFFICIENT: "INSUFFICIENT",
  GIFT_NOT_SENDABLE: "GIFT_NOT_SENDABLE",
  LUCKY_DISABLED: "LUCKY_DISABLED",
  GIFT_UNKNOWN: "GIFT_UNKNOWN",
  /** Catalog not loaded or ledger unreachable — fail CLOSED in redis mode. */
  MONEY_UNAVAILABLE: "MONEY_UNAVAILABLE",
} as const;
export type GiftRefusalCode = (typeof GiftRefusal)[keyof typeof GiftRefusal];

export const REFUSAL_REASON: Record<GiftRefusalCode, string> = {
  INSUFFICIENT: "Insufficient coins",
  GIFT_NOT_SENDABLE: "You cannot send this gift",
  LUCKY_DISABLED: "Lucky gifts are disabled",
  GIFT_UNKNOWN: "Unknown gift",
  MONEY_UNAVAILABLE: "Balance service unavailable, try again",
};

export interface PolicyInput {
  catalogLoaded: boolean;
  gift: CachedGift | undefined;
  luckyEnabled: boolean;
  level: number;
  isVip: boolean;
}

/** Returns the refusal code, or null when the gift may be sent. */
export function evaluateGiftPolicy(input: PolicyInput): GiftRefusalCode | null {
  if (!input.catalogLoaded) return GiftRefusal.MONEY_UNAVAILABLE;
  const gift = input.gift;
  if (gift === undefined) return GiftRefusal.GIFT_UNKNOWN;
  if (!gift.isActive) return GiftRefusal.GIFT_NOT_SENDABLE;
  if (input.level < gift.minLevel) return GiftRefusal.GIFT_NOT_SENDABLE;
  if (gift.vipOnly && !input.isVip) return GiftRefusal.GIFT_NOT_SENDABLE;
  if (gift.isLucky && !input.luckyEnabled) return GiftRefusal.LUCKY_DISABLED;
  return null;
}
