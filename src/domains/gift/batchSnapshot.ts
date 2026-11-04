import type { BatchProcessingResult, SenderBalanceFields } from "@src/integrations/types.js";

/**
 * One wire-shaped balance snapshot per sender, from a batch response:
 * absolute decimal strings plus the backend `balance_version` that produced
 * them — exactly what `toSnapshot()` / the RECONCILE Lua consume.
 */
export type SenderBalanceWire = SenderBalanceFields & { version: number };

/**
 * GATE (pure) — gift-authority-tick-fanout 19.
 *
 * Collect the authoritative snapshot the backend attached for each sender,
 * from BOTH `processed[]` (booked groups) and `refused_senders[]` (groups
 * refused with 4002 / 5000). The backend reads every sender once after the
 * last group commits, so entries for one sender carry the same numbers; when
 * they differ, the newest `version` wins (the ledger is monotonic anyway).
 *
 * `version` is a SIBLING of `balance` on the wire (shared contract fixture).
 * Reading it from inside `balance` — as this code did from ticket 11 until
 * ticket 19 — yields `undefined`, `toSnapshot()` returns null, and the
 * RECONCILE releases the holds onto an unchanged `db`: spendable bounces UP
 * after every settle until the backend's queued push lands. An entry with no
 * usable version (an older backend) is skipped on purpose, so the sender is
 * treated as "no snapshot" and ticket 18's forceRefresh still covers it.
 */
export function batchSnapshotsBySender(
  result: Pick<BatchProcessingResult, "processed" | "refused_senders">,
): Map<number, SenderBalanceWire> {
  const out = new Map<number, SenderBalanceWire>();

  const consider = (senderId: number, balance: SenderBalanceFields, version: unknown): void => {
    const v = Number(version);
    if (!Number.isSafeInteger(v) || v < 0) return;
    const prev = out.get(senderId);
    if (prev !== undefined && prev.version >= v) return;
    out.set(senderId, { ...balance, version: v });
  };

  for (const entry of result.processed ?? []) consider(entry.sender_id, entry.balance, entry.version);
  for (const entry of result.refused_senders ?? []) consider(entry.sender_id, entry.balance, entry.version);

  return out;
}
