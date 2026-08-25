/**
 * gift-authority-tick-fanout 10: the backend<->room-server balance contract
 * fixture is byte-identical in both repos. The backend copy is the source of
 * truth (tests/Fixtures/contracts/gift-balance-contract.json, asserted
 * against live output by GiftBalanceContractTest); this copy is what MSAB's
 * ingest/wrappers are written against. When both repos are checked out side
 * by side the two files are compared; otherwise only the local shape is
 * asserted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const local = resolve(__dirname, "../../../fixtures/contracts/gift-balance-contract.json");
const backend = resolve(__dirname, "../../../../../backend/tests/Fixtures/contracts/gift-balance-contract.json");

describe("gift balance contract fixture", () => {
  const fixture = JSON.parse(readFileSync(local, "utf8"));

  it("batch response entries carry version + already_booked + absolute balance", () => {
    const entry = fixture.batch_response.processed[0];
    expect(typeof entry.version).toBe("number");
    expect(typeof entry.already_booked).toBe("boolean");
    expect(Array.isArray(entry.transaction_ids)).toBe(true);
    for (const k of ["coins", "diamonds", "wealth_xp", "charm_xp"]) {
      expect(typeof entry.balance[k]).toBe("string");
    }
  });

  it("balance.updated payload carries version alongside the absolute snapshot", () => {
    const p = fixture.balance_updated_payload;
    expect(typeof p.version).toBe("number");
    for (const k of ["coins", "diamonds", "wealth_xp", "charm_xp"]) {
      expect(typeof p[k]).toBe("string");
    }
  });

  it.skipIf(!existsSync(backend))("is identical to the backend copy", () => {
    expect(JSON.parse(readFileSync(backend, "utf8"))).toEqual(fixture);
  });
});
