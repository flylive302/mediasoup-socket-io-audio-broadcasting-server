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
import type { Logger } from "../core/logger.js";
import type { UserSocketRepository } from "./userSocket.repository.js";
import type { LaravelEvent, EventRoutingResult, EventTarget } from "./types.js";
import { metrics } from "../core/metrics.js";

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
    const startTime = Date.now();
    const target = this.determineTarget(event);

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
          result = await this.emitToUser(
            target.userId,
            event.event,
            event.payload,
          );
          break;

        case "room":
          result = this.emitToRoom(target.roomId, event.event, event.payload);
          break;

        case "user_in_room":
          result = await this.emitToUserInRoom(
            target.userId,
            target.roomId,
            event.event,
            event.payload,
          );
          break;

        case "broadcast":
          result = this.emitToAll(event.event, event.payload);
          break;
      }

      const durationMs = Date.now() - startTime;

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

      // Record metrics
      metrics.laravelEventsReceived?.inc({
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

      return {
        delivered: false,
        targetCount: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      };
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

    // Emit to each socket
    for (const socketId of socketIds) {
      this.io.to(socketId).emit(event, payload);
    }

    return { delivered: true, targetCount: socketIds.length };
  }

  /**
   * Emit event to all sockets in a room
   */
  private emitToRoom(
    roomId: string,
    event: string,
    payload: unknown,
  ): EventRoutingResult {
    // Get count of sockets in room for metrics
    const room = this.io.sockets.adapter.rooms.get(roomId);
    const targetCount = room?.size ?? 0;

    if (targetCount === 0) {
      this.logger.debug({ roomId, event }, "Room has no sockets");
      return { delivered: false, targetCount: 0 };
    }

    this.io.to(roomId).emit(event, payload);

    return { delivered: true, targetCount };
  }

  /**
   * Emit event to a specific user within a room context
   * Used when both user_id and room_id are set
   */
  private async emitToUserInRoom(
    userId: number,
    roomId: string,
    event: string,
    payload: unknown,
  ): Promise<EventRoutingResult> {
    const socketIds = await this.userSocketRepo.getSocketIds(userId);
    const room = this.io.sockets.adapter.rooms.get(roomId);

    if (!room) {
      this.logger.debug({ userId, roomId, event }, "Room does not exist");
      return { delivered: false, targetCount: 0 };
    }

    // Find sockets belonging to user that are in the room
    const targetSockets = socketIds.filter((sid) => room.has(sid));

    if (targetSockets.length === 0) {
      this.logger.debug({ userId, roomId, event }, "User not in room");
      return { delivered: false, targetCount: 0 };
    }

    for (const socketId of targetSockets) {
      this.io.to(socketId).emit(event, payload);
    }

    return { delivered: true, targetCount: targetSockets.length };
  }

  /**
   * Broadcast event to all connected sockets
   */
  private emitToAll(event: string, payload: unknown): EventRoutingResult {
    const targetCount = this.io.sockets.sockets.size;

    this.io.emit(event, payload);

    return { delivered: true, targetCount };
  }
}
