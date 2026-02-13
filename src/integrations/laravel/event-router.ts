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
import { KNOWN_EVENT_SET } from "./types.js";
import { metrics } from "@src/infrastructure/metrics.js";

export class EventRouter {
  constructor(
    private readonly io: Server,
    private readonly userSocketRepo: UserSocketRepository,
    private readonly logger: Logger,
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
}
