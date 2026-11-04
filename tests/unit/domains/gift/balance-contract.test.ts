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
import { luckyTapToEmitSeconds } from "@src/domains/gift/luckyLatency.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { batchSnapshotsBySender } from "@src/domains/gift/batchSnapshot.js";

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

  it("ticket 19: refused_senders entries carry the same snapshot shape, beside a 4002/5000 failed row", () => {
    const entry = fixture.batch_response.refused_senders[0];
    expect(typeof entry.sender_id).toBe("number");
    expect(typeof entry.version).toBe("number");
    expect(entry).not.toHaveProperty("transaction_ids");
    for (const k of ["coins", "diamonds", "wealth_xp", "charm_xp"]) {
      expect(typeof entry.balance[k]).toBe("string");
    }
    const failed = fixture.batch_response.failed[0];
    expect([4002, 5000]).toContain(failed.code);
    expect(typeof failed.transaction_id).toBe("string");
  });

  it("ticket 19: the buffer's snapshot map reads `version` from where the fixture puts it (beside balance) for booked AND refused senders", () => {
    // This is the assertion that was missing for ten weeks: the map used to
    // read `balance.version`, which the fixture never had, so every batch
    // snapshot parsed to null and the ledger was never corrected.
    const snapshots = batchSnapshotsBySender(fixture.batch_response);
    const booked = fixture.batch_response.processed[0];
    const refused = fixture.batch_response.refused_senders[0];
    expect(snapshots.get(booked.sender_id)).toEqual({ ...booked.balance, version: booked.version });
    expect(snapshots.get(refused.sender_id)).toEqual({ ...refused.balance, version: refused.version });
    expect(snapshots.size).toBe(2);
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

  it("gift-cashback-latency 01: lucky_result_payload carries tapped_at as epoch ms the latency GATE accepts", () => {
    const payload = fixture.lucky_result_payload;
    expect(Number.isInteger(payload.tapped_at)).toBe(true);
    expect(luckyTapToEmitSeconds(payload, payload.tapped_at + 1500)).toBe(1.5);
  });
});
