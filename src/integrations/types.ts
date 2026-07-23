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
    };
  }>;
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
 * Cascade info returned by Laravel for cross-region room routing.
 * Used by edge instances to discover and connect to the origin instance.
 */
export interface CascadeInfo {
  hosting_region: string | null;
  hosting_ip: string | null;
  hosting_port: number | null;
  is_live: boolean;
}
