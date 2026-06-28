export type RoomStatus = "ACTIVE";

/**
 * Audio-delivery tier a Room is currently in (realtime-08).
 *
 *  - `interactive` — every participant on the WebRTC SFU (small/normal Rooms).
 *  - `broadcast`   — the Room crossed the Listener threshold; passive Listeners
 *    move to the CDN broadcast tier. **At this slice both modes still use WebRTC
 *    (no HLS yet)** — `mode` is the plumbed contract 09/10 build on, plus
 *    telemetry. The flip is owned by `RoomModeController`.
 */
export type RoomMode = "interactive" | "broadcast";

export interface RoomState {
  id: string;
  status: RoomStatus;
  participantCount: number;
  seatCount: number; // BL-008: Per-room seat count (default 15)
  mode: RoomMode; // realtime-08: interactive↔broadcast tier (default "interactive")
  createdAt: number;
  lastActivityAt: number;
}
