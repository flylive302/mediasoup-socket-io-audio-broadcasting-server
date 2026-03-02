/**
 * Gift transaction payload sent to Laravel backend
 * Per MSAB_PROTOCOL_REFERENCE.md Section 2
 */
export interface GiftTransaction {
  transaction_id: string;
  room_id?: string; // Optional per protocol
  sender_id: number;
  recipient_id: number;
  gift_id: number; // Changed from string to number per protocol
  quantity: number;
  timestamp: number;
  sender_socket_id: string; // Used to notify sender of error, NOT sent to Laravel
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
