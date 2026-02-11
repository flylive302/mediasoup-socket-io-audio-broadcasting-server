export type RoomStatus = "ACTIVE";

export interface RoomState {
  id: string;
  status: RoomStatus;
  participantCount: number;
  seatCount: number; // BL-008: Per-room seat count (default 15)
  createdAt: number;
  lastActivityAt: number;
}
