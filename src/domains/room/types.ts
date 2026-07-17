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

/**
 * Who last established `seatCount` (room-battery-perf/05).
 *
 *  - `default` — placeholder from room creation; the FIRST join may replace it.
 *  - `client`  — set by the room-establishing first join. Locked to later joins.
 *  - `laravel` — set by the `room.updated` relay (or the seat-take authoritative
 *    refetch). The only post-creation writer.
 *
 * Legacy state keys written before this field existed deserialize as
 * `undefined` and are treated as LOCKED (their count was already established).
 */
export type SeatCountSource = "default" | "client" | "laravel";

export interface RoomState {
  id: string;
  status: RoomStatus;
  participantCount: number;
  seatCount: number; // BL-008: Per-room seat count (default 15)
  seatCountSource?: SeatCountSource; // room-battery-perf/05: seat-count write authority
  mode: RoomMode; // realtime-08: interactive↔broadcast tier (default "interactive")
  createdAt: number;
  lastActivityAt: number;
}
