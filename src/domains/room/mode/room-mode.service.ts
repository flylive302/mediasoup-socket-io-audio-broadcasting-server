/**
 * RoomModeService — orchestrates the interactive↔broadcast flip (realtime-08).
 *
 * Thin GATE→EXECUTE→REACT wrapper around the pure `RoomModeController`:
 *   - GATE    : read the Room's current mode from room:state (skip if gone).
 *   - EXECUTE : run the controller; on a change, persist the new mode to
 *               room:state (update-if-exists Lua, so a flip racing closeRoom can
 *               never resurrect a dead Room).
 *   - REACT   : broadcast `room:mode` to the Room and log the transition.
 *
 * Driven by the RoomManager ownership heartbeat (which already iterates owned,
 * active Rooms with real presence in hand) — NOT a second poll loop. The caller
 * passes the Listener count and uses the returned mode to keep the coalesced
 * Laravel status update in sync.
 *
 * Listener count: the heartbeat passes region-wide socket `present` directly.
 * Speakers (≤ seat count, default-max 20) are a rounding error against a
 * 1000–1500 threshold and sit well inside the hysteresis band, so subtracting a
 * per-Room seat read every tick buys nothing — `present` is the proxy.
 */
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { config } from "@src/config/index.js";
import type { RoomMode } from "../types.js";
import type { RoomStateRepository } from "../roomState.js";
import { RoomModeController } from "./room-mode-controller.js";

export class RoomModeService {
  private readonly controller: RoomModeController;

  constructor(
    private readonly state: RoomStateRepository,
    private readonly io: Server,
    private readonly logger: Logger,
    controller: RoomModeController = new RoomModeController(),
  ) {
    this.controller = controller;
  }

  /**
   * Evaluate (and, if needed, flip) a Room's mode for the given Listener count.
   * Returns the Room's mode after evaluation (unchanged when no flip occurred),
   * or null if the Room's state key is gone (closed) — the caller should then
   * skip mode-related bookkeeping for it.
   */
  async evaluate(roomId: string, listenerCount: number): Promise<RoomMode | null> {
    // GATE — need a current mode to decide from; a missing key means closed.
    const current = await this.state.get(roomId);
    if (!current) {
      return null;
    }

    const decision = this.controller.decide({
      currentMode: current.mode,
      listenerCount,
      upThreshold: config.ROOM_BROADCAST_THRESHOLD_UP,
      downThreshold: config.ROOM_BROADCAST_THRESHOLD_DOWN,
    });

    if (!decision.changed) {
      return current.mode;
    }

    // EXECUTE — persist the flip. Update-if-exists: a null result means the Room
    // closed between the read and the write; abandon the flip so we never emit a
    // mode change for a dead Room.
    const persisted = await this.state.setMode(roomId, decision.mode);
    if (persisted === null) {
      return null;
    }

    // REACT — fire-and-forget telemetry + client notification. The mode is
    // plumbing-only at this slice (no transport change), so this is the visible
    // effect: clients/telemetry learn the Room flipped.
    this.io.to(roomId).emit("room:mode", {
      roomId,
      mode: decision.mode,
      transition: decision.transition,
      listenerCount,
      timestamp: Date.now(),
    });

    this.logger.info(
      {
        roomId,
        transition: decision.transition,
        mode: decision.mode,
        listenerCount,
      },
      "Room mode flipped",
    );

    return persisted;
  }
}
