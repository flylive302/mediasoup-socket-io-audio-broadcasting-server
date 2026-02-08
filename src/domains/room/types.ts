export type RoomStatus = "CREATED" | "ACTIVE" | "CLOSING" | "CLOSED";

export interface RoomState {
  id: string;
  status: RoomStatus;
  participantCount: number;
  createdAt: number;
  lastActivityAt: number;
  speakers: string[]; // List of userIds in seats
}

export interface Seat {
  index: number;
  userId: string | null;
  muted: boolean;
}
