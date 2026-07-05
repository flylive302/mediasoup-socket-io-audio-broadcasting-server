/**
 * Seat domain types
 */

export interface SeatData {
  index: number;
  userId: string | null;
  muted: boolean;
  locked: boolean;
}

export interface SeatAssignment {
  userId: string;
  muted: boolean;
  // realtime-22: epoch ms when the occupant's socket was declared dead. Present
  // ONLY while the seat is being held through a reconnect grace window (set by
  // seatReserve, cleared by seatReclaim, swept when older than the grace window).
  // A seat with this field is still OCCUPIED for all other purposes (take/assign
  // by others returns SEAT_TAKEN) — occupancy readers ignore the field.
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
