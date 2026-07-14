/**
 * Seat domain types
 */

export interface SeatData {
  index: number;
  userId: string | null;
  muted: boolean;
  locked: boolean;
  /**
   * Seat is held for a disconnected occupant inside the reconnect grace
   * window (live `disconnectedAt` marker): seat:take by others still rejects,
   * but the leave was already broadcast — snapshots must NOT list it as
   * occupied, and clients render it empty.
   */
  reserved: boolean;
}

export interface SeatAssignment {
  userId: string;
  muted: boolean;
  // realtime-22 (reworked): epoch ms when the occupant's socket was declared
  // dead. Present ONLY while the seat is reserved through the reconnect grace
  // window (set by seatReserve, cleared by seatReclaim, swept when older than
  // the grace window). Take/assign by others returns SEAT_TAKEN, but clients
  // already saw the seat cleared at disconnect — snapshot builders must treat
  // the seat as empty (see SeatData.reserved).
  disconnectedAt?: number;
}

export interface PendingInvite {
  targetUserId: string;
  invitedBy: string;
  seatIndex: number;
  createdAt: number;
}

export type SeatActionResult =
  | {
      success: true;
      seatIndex: number;
      previousSeatIndex?: number | null;
      // F-41: every other seat this user held that was vacated by the
      // operation. Handlers emit one `seat:cleared` per index so observers
      // drop all stale slots (the user can only occupy one seat).
      clearedSeatIndices?: number[];
    }
  | { success: false; error: string };
