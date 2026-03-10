/**
 * Event Router
 * Routes Laravel events to appropriate Socket.IO targets
 *
 * Routing logic:
 * - user_id set, room_id null → emit to user's sockets
 * - room_id set, user_id null → emit to room
 * - both set → emit to user's sockets in that room context
 * - both null → broadcast to all
 */
import type { Server } from "socket.io";
import type { Logger } from "@src/infrastructure/logger.js";
import type { UserSocketRepository } from "./user-socket.repository.js";
import type { LaravelEvent, EventRoutingResult, EventTarget } from "./types.js";
import { KNOWN_EVENT_SET, RELAY_EVENTS } from "./types.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { syncVipLevelOnSockets } from "@src/domains/seat/vip.guard.js";
import type { ClientManager } from "@src/client/clientManager.js";
import type { User } from "@src/auth/types.js";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";

export class EventRouter {
  constructor(
    private readonly io: Server,
    private readonly userSocketRepo: UserSocketRepository,
    private readonly clientManager: ClientManager,
    private readonly logger: Logger,
    private readonly roomStateRepo?: RoomStateRepository,
  ) {}

  /**
   * Route an event to appropriate Socket.IO targets
   */
  async route(event: LaravelEvent): Promise<EventRoutingResult> {
    // Allowlist gate — only registered events pass through
    if (!KNOWN_EVENT_SET.has(event.event)) {
      this.logger.error(
        { event: event.event, correlationId: event.correlation_id },
        "Unknown relay event — register in RELAY_EVENTS (types.ts) before publishing",
      );
      metrics.laravelEventsReceived.inc({
        event_type: "unknown",
        delivered: "rejected",
      });
      return { delivered: false, targetCount: 0, error: "Unknown event" };
    }

    const startTime = Date.now();
    const target = this.determineTarget(event);
    metrics.laravelEventsInFlight.inc();

    this.logger.debug(
      {
        event: event.event,
        target,
        correlationId: event.correlation_id,
      },
      "Routing event",
    );

    try {
      let result: EventRoutingResult;

      switch (target.type) {
        case "user":
        case "user_in_room":
          result = await this.emitToUser(
            target.userId,
            event.event,
            event.payload,
          );
          break;

        case "room":
          result = this.emitToRoom(target.roomId, event.event, event.payload);
          break;

        case "broadcast":
          result = this.emitToAll(event.event, event.payload);
          break;
      }

      const durationMs = Date.now() - startTime;
      const durationSec = durationMs / 1000;

      this.logger.debug(
        {
          event: event.event,
          target,
          delivered: result.delivered,
          targetCount: result.targetCount,
          durationMs,
          correlationId: event.correlation_id,
        },
        "Event routed",
      );

      // RL-012 FIX: Duration metric now includes async routing time
      metrics.laravelEventProcessingDuration.observe(
        { event_type: event.event },
        durationSec,
      );

      // RL-007 FIX: Remove optional chaining — metric is always initialized
      metrics.laravelEventsReceived.inc({
        event_type: event.event,
        delivered: result.delivered ? "true" : "false",
      });

      // Post-relay side-effect: sync socket.data.user when VIP status changes
      if (
        result.delivered &&
        event.event === RELAY_EVENTS.vip.VIP_UPDATED &&
        event.user_id !== null
      ) {
        try {
          const vipLevel =
            typeof event.payload.vip_level === "number"
              ? event.payload.vip_level
              : 0;
          syncVipLevelOnSockets(this.io, event.user_id, vipLevel);

          // Broadcast to rooms so other participants see the VIP change
          const vipProfile = { vip_level: vipLevel } as Partial<User>;
          const affectedRooms = this.clientManager.updateUserProfile(
            event.user_id,
            vipProfile,
          );
          for (const roomId of affectedRooms) {
            this.io.to(roomId).emit("user:profile_updated", {
              user_id: event.user_id,
              profile: vipProfile,
            });
          }
        } catch (syncErr) {
          // Non-blocking — VIP sync failure should not break event routing
          this.logger.warn(
            { err: syncErr, userId: event.user_id },
            "Failed to sync VIP level on sockets",
          );
        }
      }

      // Post-relay side-effect: update in-memory user data on profile change
      if (
        event.event === RELAY_EVENTS.user.PROFILE_UPDATED &&
        event.user_id !== null
      ) {
        this.syncUserProfile(event.user_id, event.payload);
      }

      // Post-relay side-effect: sync room settings (seatCount) to RoomState
      if (
        result.delivered &&
        event.event === RELAY_EVENTS.room.ROOM_UPDATED &&
        event.room_id !== null
      ) {
        this.syncRoomSettings(String(event.room_id), event.payload);
      }

      return result;
    } catch (err) {
      this.logger.error(
        {
          err,
          event: event.event,
          correlationId: event.correlation_id,
        },
        "Failed to route event",
      );

      // RL-014 FIX: Count failed events so they're visible in Prometheus
      metrics.laravelEventsReceived.inc({
        event_type: event.event,
        delivered: "error",
      });

      return {
        delivered: false,
        targetCount: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    } finally {
      metrics.laravelEventsInFlight.dec();
    }
  }

  /**
   * Determine routing target from event
   */
  private determineTarget(event: LaravelEvent): EventTarget {
    const { user_id, room_id } = event;

    if (user_id !== null && room_id !== null) {
      return {
        type: "user_in_room",
        userId: user_id,
        roomId: String(room_id),
      };
    }

    if (room_id !== null) {
      return {
        type: "room",
        roomId: String(room_id),
      };
    }

    if (user_id !== null) {
      return {
        type: "user",
        userId: user_id,
      };
    }

    return { type: "broadcast" };
  }

  /**
   * Emit event to all sockets belonging to a user
   */
  private async emitToUser(
    userId: number,
    event: string,
    payload: unknown,
  ): Promise<EventRoutingResult> {
    const socketIds = await this.userSocketRepo.getSocketIds(userId);

    if (socketIds.length === 0) {
      this.logger.debug({ userId, event }, "User has no active sockets");
      return { delivered: false, targetCount: 0 };
    }

    // Chain .to() for a single adapter call instead of N separate emits
    let target = this.io.to(socketIds[0]!);
    for (let i = 1; i < socketIds.length; i++) {
      target = target.to(socketIds[i]!);
    }
    target.emit(event, payload);

    return { delivered: true, targetCount: socketIds.length };
  }

  /**
   * Emit event to all sockets in a room.
   * Emits unconditionally — Redis adapter handles cross-instance delivery.
   * Local room count is informational only (not a delivery gate).
   */
  private emitToRoom(
    roomId: string,
    event: string,
    payload: unknown,
  ): EventRoutingResult {
    this.io.to(roomId).emit(event, payload);
    const localCount = this.io.sockets.adapter.rooms.get(roomId)?.size ?? 0;

    return { delivered: true, targetCount: localCount };
  }

  /**
   * Broadcast event to all connected sockets.
   * io.emit() broadcasts to all instances via Redis adapter.
   * targetCount reflects local sockets only (informational).
   */
  private emitToAll(event: string, payload: unknown): EventRoutingResult {
    this.io.emit(event, payload);
    const localCount = this.io.sockets.sockets.size;

    return { delivered: true, targetCount: localCount };
  }


  /**
   * Sync user profile data across all in-memory stores and broadcast to rooms.
   * Called as a post-relay side-effect for `user.profile.updated` events.
   */
  private syncUserProfile(
    userId: number,
    payload: Record<string, unknown>,
  ): void {
    const profile = payload.profile as Partial<User> | undefined;
    if (!profile || typeof profile !== "object") {
      this.logger.warn(
        { userId },
        "user.profile.updated: missing or invalid profile in payload",
      );
      return;
    }

    try {
      // 1. Update ClientManager in-memory user data
      const affectedRooms = this.clientManager.updateUserProfile(
        userId,
        profile,
      );

      // 2. Sync socket.data.user on all live sockets for this user
      for (const [, socket] of this.io.sockets.sockets) {
        if (socket.data?.user?.id === userId) {
          socket.data.user = { ...socket.data.user, ...profile };
        }
      }

      // 3. Broadcast to rooms so other clients can refresh UI
      for (const roomId of affectedRooms) {
        this.io.to(roomId).emit("user:profile_updated", {
          user_id: userId,
          profile,
        });
      }

      this.logger.info(
        { userId, rooms: affectedRooms.size },
        "User profile synced",
      );
    } catch (err) {
      // Non-blocking — profile sync failure should not break event routing
      this.logger.warn(
        { err, userId },
        "Failed to sync user profile",
      );
    }
  }

  /**
   * Sync room settings to RoomState when room.updated relay contains max_seats.
   * Keeps MSAB's seat validation in sync without requiring a new user join.
   */
  private syncRoomSettings(
    roomId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.roomStateRepo) return;

    const room = payload.room as { max_seats?: number } | undefined;
    const maxSeats = room?.max_seats;
    if (typeof maxSeats !== "number" || maxSeats < 1 || maxSeats > 15) return;

    this.roomStateRepo
      .get(roomId)
      .then((state) => {
        if (!state || state.seatCount === maxSeats) return;
        state.seatCount = maxSeats;
        return this.roomStateRepo!.save(state);
      })
      .then(() => {
        this.logger.info(
          { roomId, maxSeats },
          "Room seatCount synced from room.updated",
        );
      })
      .catch((err) => {
        // Non-blocking — seatCount sync failure should not break event routing
        this.logger.warn(
          { err, roomId },
          "Failed to sync room seatCount from room.updated",
        );
      });
  }
}
