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
