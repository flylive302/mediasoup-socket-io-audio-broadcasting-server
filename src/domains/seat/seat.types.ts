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
  | { success: true; seatIndex: number }
  | { success: false; error: string };
