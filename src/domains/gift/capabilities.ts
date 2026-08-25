/**
 * gift-authority-tick-fanout 14: capability handshake payload.
 *
 * Pulled out of `socket/index.ts`'s connection handler into its own pure
 * function so the flag → capability mapping is unit-testable without
 * booting the whole socket composition root. Read fresh on every call
 * (never cached) so a runtime flip is reflected on the very next connect.
 */
import { giftBalanceAuthority, giftRoomTickMs } from "./flags.js";

export interface ServerCapabilities {
  /** Advertised only when GIFT_ROOM_TICK_MS > 0 — see roomTicker.ts. */
  giftBatch: boolean;
  /**
   * ticket 12: advertised only in `redis` mode — the gift:send ack then
   * carries `balance`/`seq` and balance pushes are spendable-rewritten.
   * Old bundles ignore it and keep today's behaviour.
   */
  ackBalance: boolean;
}

export function getServerCapabilities(): ServerCapabilities {
  return { giftBatch: giftRoomTickMs() > 0, ackBalance: giftBalanceAuthority() === "redis" };
}
