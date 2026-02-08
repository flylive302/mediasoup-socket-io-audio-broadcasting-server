/**
 * Room domain types
 */

export type RoomStatus = "active" | "closed";

export interface RoomMetadata {
  id: string;
  ownerId: string;
  name: string;
  seatCount: number;
  status: RoomStatus;
  participantCount: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface RoomJoinResult {
  success: boolean;
  error?: string;
  rtpCapabilities?: unknown;
  seats?: unknown[];
  producers?: unknown[];
  participantCount?: number;
}
