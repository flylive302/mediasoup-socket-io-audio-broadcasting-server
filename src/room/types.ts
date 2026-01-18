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

export interface SeatUser {
  id: string | number;
  name?: string;
  avatar?: string;
  signature?: string;
  gender?: string;
  country?: string;
  phone?: string;
  email?: string | null;
  date_of_birth?: string;
  wealth_xp?: string;
  charm_xp?: string;
}