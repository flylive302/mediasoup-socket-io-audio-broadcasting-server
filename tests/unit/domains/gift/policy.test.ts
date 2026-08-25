import { describe, it, expect } from "vitest";
import { evaluateGiftPolicy, GiftRefusal, REFUSAL_REASON } from "@src/domains/gift/policy.js";

const gift = { id: 1, price: 10, isActive: true, isLucky: false, minLevel: 0, vipOnly: false };
const base = { catalogLoaded: true, gift, luckyEnabled: true, level: 0, isVip: false };

describe("evaluateGiftPolicy (ticket 12, pure GATE)", () => {
  it("allows a plain active gift", () => expect(evaluateGiftPolicy(base)).toBeNull());
  it("fails closed when the catalog is not loaded, before looking at the gift", () =>
    expect(evaluateGiftPolicy({ ...base, catalogLoaded: false, gift: undefined })).toBe(GiftRefusal.MONEY_UNAVAILABLE));
  it("unknown gift", () => expect(evaluateGiftPolicy({ ...base, gift: undefined })).toBe(GiftRefusal.GIFT_UNKNOWN));
  it("inactive gift", () => expect(evaluateGiftPolicy({ ...base, gift: { ...gift, isActive: false } })).toBe(GiftRefusal.GIFT_NOT_SENDABLE));
  it("level gate is inclusive at minLevel", () => {
    expect(evaluateGiftPolicy({ ...base, gift: { ...gift, minLevel: 5 }, level: 4 })).toBe(GiftRefusal.GIFT_NOT_SENDABLE);
    expect(evaluateGiftPolicy({ ...base, gift: { ...gift, minLevel: 5 }, level: 5 })).toBeNull();
  });
  it("vip-only", () => {
    expect(evaluateGiftPolicy({ ...base, gift: { ...gift, vipOnly: true } })).toBe(GiftRefusal.GIFT_NOT_SENDABLE);
    expect(evaluateGiftPolicy({ ...base, gift: { ...gift, vipOnly: true }, isVip: true })).toBeNull();
  });
  it("lucky gift while lucky disabled", () => {
    expect(evaluateGiftPolicy({ ...base, gift: { ...gift, isLucky: true }, luckyEnabled: false })).toBe(GiftRefusal.LUCKY_DISABLED);
    expect(evaluateGiftPolicy({ ...base, gift: { ...gift, isLucky: true } })).toBeNull();
  });
  it("every code has a reason string", () => {
    for (const code of Object.values(GiftRefusal)) expect(REFUSAL_REASON[code]).toBeTruthy();
  });
});
