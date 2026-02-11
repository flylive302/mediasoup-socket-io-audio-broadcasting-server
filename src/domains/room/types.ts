export type RoomStatus = "CREATED" | "ACTIVE" | "CLOSING" | "CLOSED";

export interface RoomState {
  id: string;
  status: RoomStatus;
  participantCount: number;
  seatCount: number; // BL-008: Per-room seat count (default 15)
  createdAt: number;
  lastActivityAt: number;
  speakers: string[]; // List of userIds in seats
}

export interface Seat {
  index: number;
  userId: string | null;
  muted: boolean;
}
