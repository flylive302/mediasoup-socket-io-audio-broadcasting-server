/**
 * Gift transaction payload sent to Laravel backend
 * Per MSAB_PROTOCOL_REFERENCE.md Section 2
 *
 * lucky-burst-draw 08: burst-native — one row per send event (single or
 * multi-recipient), carrying the post-seat-filter accepted recipient list.
 * The legacy single-recipient socket event is normalized to a 1-element
 * array at enqueue time so exactly one row shape exists below the edge.
 */
export interface GiftTransaction {
  transaction_id: string;
  room_id?: number; // Numeric room ID (parsed from socket string)
  sender_id: number;
  recipient_ids: number[];
  gift_id: number; // Changed from string to number per protocol
  quantity: number;
  timestamp: number;
  sender_socket_id: string; // Used to notify sender of error, NOT sent to Laravel
  batch_id?: string | undefined; // Client burst batchId — echoed on gift:error so the FE keys its refund
}

/**
 * gift-batch-503 04: Laravel ran out of its per-request time budget before
 * this tap's group was opened. Nothing was booked for it. NOT terminal — the
 * buffer re-queues the tap whole (no gift:error, no ledger settle). Mirrors
 * `GiftBatchProcessor::CODE_RETRY`.
 */
export const GIFT_BATCH_RETRY_CODE = 5030;

/**
 * Response from Laravel batch gift processing endpoint
 * Per MSAB_PROTOCOL_REFERENCE.md Section 2
 */
export interface BatchProcessingResult {
  processed_count: number; // Renamed from "processed" per protocol
  failed: Array<{
    transaction_id: string;
    code: number; // Error code (e.g., 4002) - per protocol
    reason: string; // Renamed from "error" per protocol
    sender_socket_id?: string; // Internal use for notifying sender
  }>;
  /**
   * Epic B ticket 06: per-group authoritative sender balance snapshots,
   * shaped exactly like the `balance.updated` event payload. Optional so a
   * not-yet-upgraded Laravel response stays valid.
   */
  processed?: Array<{
    transaction_ids: string[];
    sender_id: number;
    balance: {
      coins: string;
      diamonds: string;
      wealth_xp: string;
      charm_xp: string;
      /** gift-authority-tick-fanout 06: backend `balance_version` for this snapshot. */
      version?: number;
    };
    /** 06: true when every id in the group was a replay of an earlier booking. */
    already_booked?: boolean;
  }>;
  /**
   * gift-backlog-and-lag 03: true when Laravel's `GIFT_LUCKY_INLINE` flag is
   * on and the batch commit inlined the lucky result below instead of
   * relying on the queued `lucky:*` relay via event-router.ts. The backend
   * env var is the single switch — MSAB carries no flag of its own and
   * simply reads this field when present.
   */
  lucky_inline?: boolean;
  /** See `lucky_inline` and `LuckyInlineEntry`. */
  lucky?: LuckyInlineEntry[];
}

/**
 * gift-backlog-and-lag 03: one lucky-draw outcome for one gift group in the
 * batch, carried inline in the HTTP response instead of arriving later via
 * the queued `lucky:*` Laravel events routed by event-router.ts. `sender` is
 * the exact payload the client already receives as `lucky:result` (kind
 * "result") or `lucky:no-draw` (kind "no-draw"); `room` is the exact
 * `lucky:room-result` payload, or null for a no-draw (nothing to show the
 * room). See docs/issues/gift-backlog-and-lag/03-lucky-result-inline-in-batch-response.md.
 */
export interface LuckyInlineEntry {
  transaction_ids: string[];
  sender_id: number;
  room_id: number;
  kind: "result" | "no-draw";
  sender: Record<string, unknown>;
  room: Record<string, unknown> | null;
}

/**
 * Room status update payload sent to Laravel backend
 * Per MSAB_PROTOCOL_REFERENCE.md Section 4
 */
export interface RoomStatusUpdate {
  is_live: boolean;
  participant_count: number;
  started_at?: string; // ISO 8601 timestamp, optional
  ended_at?: string | null; // Renamed from "closed_at" per protocol
  hosting_region?: string | null; // AWS region hosting this room (e.g., "ap-south-1")
  hosting_ip?: string | null; // Public IP of the MSAB instance hosting this room
  hosting_port?: number | null; // HTTPS port of the MSAB instance (for internal API)
  mode?: "interactive" | "broadcast"; // realtime-08: interactive↔broadcast tier. Absent = "leave unchanged" on the Laravel side.
}

/**
 * Honest counts from one drain re-pin batch (aws-production/20).
 * `unplaced` = rooms Laravel found no healthy target for (pin kept);
 * `remaining` = rooms still pinned to this instance after the batch.
 */
export interface RepinBatchResult {
  repinned: number;
  unplaced: number;
  remaining: number;
  held: number;
}

/**
 * Cascade info returned by Laravel for cross-region room routing.
 * Used by edge instances to discover and connect to the origin instance.
 */
export interface CascadeInfo {
  hosting_region: string | null;
  hosting_ip: string | null;
  hosting_port: number | null;
  is_live: boolean;
}
