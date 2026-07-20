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
import type { Redis } from "ioredis";
import type { Logger } from "@src/infrastructure/logger.js";
import type { UserSocketRepository } from "./user-socket.repository.js";
import type { LaravelEvent, EventRoutingResult, EventTarget } from "./types.js";
import { KNOWN_EVENT_SET, RELAY_EVENTS } from "./types.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { syncVipLevelOnSockets } from "@src/domains/seat/vip.guard.js";
import type { ClientManager } from "@src/client/clientManager.js";
import type { User } from "@src/auth/types.js";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";
import { syncUserProfileInMemory } from "@src/shared/profile-sync.js";
import { reactError } from "@src/shared/react-error.js";
import { ActiveAppSlidesRepository } from "@src/domains/slide/index.js";
import { config } from "@src/config/index.js";
import type { RoomManager } from "@src/domains/room/roomManager.js";
import { RoomBlockRepository } from "@src/domains/room/room-block.repository.js";
import type { SeatRepository } from "@src/domains/seat/seat.repository.js";
import type { StatusCoalescer } from "@src/domains/room/status-coalescer.js";
import type { UserRoomRepository } from "./user-room.repository.js";
import { ejectRoomMember } from "@src/domains/room/ejectRoomMember.js";

/** Payload for auth.force_disconnect relay event */
interface ForceDisconnectPayload {
  reason: string;
  blocked_until?: string | null;
  blocked_reason?: string | null;
}

export class EventRouter {
  /** Records app-scope slides so late joiners can replay them (see room:join). */
  private readonly activeAppSlides: ActiveAppSlidesRepository;
  /** ADR 0017 / room-blocks 03: Redis mirror of the Laravel block gate. */
  private readonly roomBlockRepo: RoomBlockRepository;

  constructor(
    private readonly io: Server,
    private readonly userSocketRepo: UserSocketRepository,
    private readonly clientManager: ClientManager,
    private readonly logger: Logger,
    private readonly redis: Redis,
    private readonly roomStateRepo?: RoomStateRepository,
    /**
     * realtime-13 (L2): force-close a room's cluster IF it is hosted on this
     * instance. Gated by the caller on local ownership so the unsafe
     * orphan-reap path is never taken from an admin force-close — a non-hosting
     * instance simply does nothing (Laravel reconciles the DB independently).
     */
    private readonly forceCloseLocalRoom?: (
      roomId: string,
      reason: string,
    ) => Promise<void>,
    /**
     * room-seat-caps/02: source of the shrink-eviction path (producer close +
     * seat:cleared/seat:evicted). Optional so existing unit tests that
     * construct EventRouter without it keep passing — syncRoomSettings simply
     * skips eviction (still updates seatCount) when unset.
     */
    private readonly roomManager?: RoomManager,
    /**
     * room-blocks/02 (ADR 0017): ejection machinery deps, driven by the
     * `room.member_removed` fanout instead of a direct client `room:kick`
     * emit. Optional so existing unit tests that construct EventRouter
     * without them keep passing — ejectMemberOnBlock simply no-ops (the
     * client still self-ejects on room.member_removed) when unset.
     */
    private readonly seatRepository?: SeatRepository,
    private readonly statusCoalescer?: StatusCoalescer,
    private readonly userRoomRepository?: UserRoomRepository,
  ) {
    this.activeAppSlides = new ActiveAppSlidesRepository(this.redis);
    this.roomBlockRepo = new RoomBlockRepository(this.redis, this.logger);
  }

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

      // ─── REACT Stage: Post-relay side-effects (fire-and-forget) ───────────
      // These are the REACT layer of the INTENT → GATE → EXECUTE → REACT pipeline.
      // They run after the main relay (EXECUTE) and must be non-blocking.

      // REACT: sync socket.data.user when VIP status changes
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
          syncVipLevelOnSockets(this.io, event.user_id, vipLevel, this.userSocketRepo);

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

      // REACT: Write user-level revocation key to local Redis
      if (
        event.event === RELAY_EVENTS.auth.REVOKE_TOKENS &&
        event.user_id !== null
      ) {
        this.writeRevocationKey(
          event.user_id,
          event.payload.revoked_at as number,
        );
      }

      // REACT: Force-disconnect all user sockets
      if (
        event.event === RELAY_EVENTS.auth.FORCE_DISCONNECT &&
        event.user_id !== null
      ) {
        await this.forceDisconnectUser(
          event.user_id,
          event.payload as unknown as ForceDisconnectPayload,
        );
      }

      // Post-relay side-effect: sync room settings (seatCount) to RoomState
      if (
        result.delivered &&
        event.event === RELAY_EVENTS.room.ROOM_UPDATED &&
        event.room_id !== null
      ) {
        this.syncRoomSettings(String(event.room_id), event.payload);
      }

      // REACT: admin force-close. Fire-and-forget so routing never blocks on the
      // cluster teardown; the caller-supplied closer already no-ops unless this
      // instance hosts the room, so the unsafe orphan-reap path is never hit.
      if (
        event.event === RELAY_EVENTS.room.ROOM_FORCE_CLOSE &&
        event.room_id !== null &&
        this.forceCloseLocalRoom
      ) {
        this.forceCloseLocalRoom(String(event.room_id), "admin_force_close").catch(
          (err) =>
            reactError(err, { roomId: event.room_id }, "Admin force-close failed", {
              level: "error",
              logger: this.logger,
            }),
        );
      }

      // REACT: record app-scope slides (room_id null = broadcast to every room)
      // so a user joining a room mid-slide replays it from their join response.
      if (
        result.delivered &&
        event.event === RELAY_EVENTS.slide.SLIDE_PLAY &&
        event.room_id === null &&
        (event.payload as { scope?: string }).scope === "app"
      ) {
        this.activeAppSlides
          .record(event.payload)
          .catch((err) =>
            reactError(err, {}, "Failed to record active app slide", {
              logger: this.logger,
            }),
          );
      }

      // REACT: mirror a block into Redis so room:join's GATE can reject the
      // direct-socket bypass without hitting Laravel. Fire-and-forget — a
      // failed mirror write degrades to fail-open (Laravel's HTTP gate stays
      // authoritative), never blocks event routing.
      if (event.event === RELAY_EVENTS.room.ROOM_MEMBER_REMOVED) {
        this.mirrorRoomBlock(event.payload);
      }

      // REACT: unified kick path (ADR 0017, room-blocks/02) — ejection
      // machinery previously in the retired `room:kick` socket handler, now
      // driven by this fanout ingest. Fire-and-forget: the client also
      // self-ejects (leaveRoom + navigate) on room.member_removed, so a
      // failed/slow ejection here degrades to eventual consistency, never
      // blocks event routing.
      // Laravel emits this event twice (user-targeted and room-broadcast),
      // and each envelope carries only ONE of user_id/room_id — both ids
      // live in the payload. Gate on the room-broadcast copy so the
      // ejection runs exactly once per kick.
      if (
        event.event === RELAY_EVENTS.room.ROOM_MEMBER_REMOVED &&
        event.room_id !== null
      ) {
        const removed = event.payload as {
          room_id?: number | string;
          user_id?: number;
        };
        if (removed.user_id != null) {
          this.ejectMemberOnBlock(String(event.room_id), removed.user_id);
        }
      }

      // REACT: mirror an unblock — delete the Redis key so a natural rejoin
      // succeeds immediately with no residual friction.
      if (event.event === RELAY_EVENTS.room.ROOM_USER_UNBLOCKED) {
        this.mirrorRoomUnblock(event.payload);
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
   *
   * A-2 FIX: Delegates to shared syncUserProfileInMemory() utility (DRY with user.handler.ts)
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

    syncUserProfileInMemory(
      this.io,
      this.clientManager,
      userId,
      profile,
      this.userSocketRepo,
    )
      .then((affectedRooms) => {
        this.logger.info(
          { userId, rooms: affectedRooms.size },
          "User profile synced",
        );
      })
      .catch((err) => {
        // Non-blocking — profile sync failure should not break event routing
        reactError(err, { userId }, "Failed to sync user profile", {
          logger: this.logger,
        });
      });
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
    if (
      typeof maxSeats !== "number" ||
      maxSeats < 1 ||
      maxSeats > config.MAX_SEAT_COUNT
    ) {
      this.logger.warn(
        { roomId, maxSeats, max: config.MAX_SEAT_COUNT },
        "Rejected out-of-bounds maxSeats from room.updated",
      );
      return;
    }

    this.roomStateRepo
      .get(roomId)
      .then(async (state) => {
        // room-battery-perf/05: even when the value is unchanged, stamp the
        // source so a pending "default" (no join yet) can no longer be
        // claimed by a joiner's payload once Laravel has spoken.
        if (!state || (state.seatCount === maxSeats && state.seatCountSource === "laravel")) return;
        const previousSeatCount = state.seatCount;
        state.seatCount = maxSeats;
        state.seatCountSource = "laravel";
        await this.roomStateRepo!.save(state);

        this.logger.info(
          { roomId, maxSeats },
          "Room seatCount synced from room.updated",
        );

        // room-seat-caps/02: shrink only — evict displaced occupants. Grow
        // (maxSeats > previousSeatCount) never evicts, never emits.
        if (this.roomManager && maxSeats < previousSeatCount) {
          this.evictShrunkSeats(roomId, maxSeats);
        }
      })
      .catch((err) => {
        // Non-blocking — seatCount sync failure should not break event routing
        reactError(err, { roomId }, "Failed to sync room seatCount from room.updated", {
          logger: this.logger,
        });
      });
  }

  /**
   * REACT: fire-and-forget shrink eviction, kept off the syncRoomSettings
   * promise chain so a slow eviction never delays the room.updated ack.
   */
  private evictShrunkSeats(roomId: string, newSeatCount: number): void {
    this.roomManager!
      .evictShrunkSeats(roomId, newSeatCount, this.clientManager)
      .catch((err) => {
        reactError(err, { roomId, newSeatCount }, "Failed to evict shrunk seats", {
          logger: this.logger,
        });
      });
  }

  /**
   * Write user-level revocation key to local Redis.
   * Any JWT with iat < revokedAt will be rejected by jwtValidator.
   * TTL matches JWT lifetime so the key auto-expires when no valid tokens remain.
   */
  private writeRevocationKey(userId: number, revokedAt: number): void {
    const key = `auth:user_revoked:${userId}`;
    const ttl = config.JWT_MAX_AGE_SECONDS; // 24h — matches JWT lifetime (F-56)
    this.redis
      .set(key, String(revokedAt), "EX", ttl)
      .then(() => {
        this.logger.info(
          { userId, revokedAt },
          "User revocation key written to local Redis",
        );
      })
      .catch((err) => {
        reactError(
          err,
          { userId },
          "Failed to write user revocation key — user may reconnect with old JWT",
          { level: "error", logger: this.logger },
        );
      });
  }

  /**
   * ADR 0017 / room-blocks 03: write the Redis block-gate mirror from a
   * `room.member_removed` fanout payload. `remaining_seconds` null/absent
   * (permanent flag set) writes with no TTL; otherwise `EX remaining_seconds`
   * so the key self-expires with no cleanup action.
   */
  private mirrorRoomBlock(payload: Record<string, unknown>): void {
    const roomId = payload.room_id;
    const userId = payload.user_id;
    if (typeof roomId !== "number" && typeof roomId !== "string") return;
    if (typeof userId !== "number") return;

    const permanent = payload.permanent === true;
    const remainingSeconds =
      typeof payload.remaining_seconds === "number"
        ? payload.remaining_seconds
        : null;

    this.roomBlockRepo
      .writeBlock(String(roomId), userId, permanent ? null : remainingSeconds)
      .catch((err) =>
        reactError(err, { roomId, userId }, "Failed to mirror room block into Redis", {
          logger: this.logger,
        }),
      );
  }

  /**
   * ADR 0017 / room-blocks 03: delete the Redis block-gate mirror from a
   * `room.user_unblocked` fanout payload.
   */
  private mirrorRoomUnblock(payload: Record<string, unknown>): void {
    const roomId = payload.room_id;
    const userId = payload.user_id;
    if (typeof roomId !== "number" && typeof roomId !== "string") return;
    if (typeof userId !== "number") return;

    this.roomBlockRepo
      .deleteBlock(String(roomId), userId)
      .catch((err) =>
        reactError(err, { roomId, userId }, "Failed to delete room block Redis mirror", {
          logger: this.logger,
        }),
      );
  }

  /**
   * ADR 0017 / room-blocks 02: run the ejection machinery (seat clear,
   * force socket.leave, participant count + Laravel status update) for a
   * user just blocked via the unified kick path. No-ops when the optional
   * ejection deps weren't supplied (e.g. unit tests constructing EventRouter
   * without them) — the client's own self-eject on room.member_removed still
   * covers ejection in that case.
   */
  private ejectMemberOnBlock(roomId: string, userId: number): void {
    if (!this.seatRepository || !this.roomStateRepo || !this.statusCoalescer || !this.userRoomRepository) {
      return;
    }

    ejectRoomMember(
      {
        io: this.io,
        seatRepository: this.seatRepository,
        clientManager: this.clientManager,
        roomStateRepo: this.roomStateRepo,
        statusCoalescer: this.statusCoalescer,
        userRoomRepository: this.userRoomRepository,
        logger: this.logger,
        // dj-talk-over/02: producer + music-mutex cleanup on kick — no-ops
        // if roomManager wasn't supplied (mirrors the eviction-deps pattern).
        redis: this.redis,
        cascadeRelay: this.roomManager?.getCascadeRelay() ?? null,
        getRoom: this.roomManager ? (id: string) => this.roomManager!.getRoom(id) : undefined,
      },
      roomId,
      userId,
    ).catch((err) =>
      reactError(err, { roomId, userId }, "Failed to eject room member on block", {
        logger: this.logger,
      }),
    );
  }

  /**
   * Disconnect all sockets for a user and notify the client.
   * The client receives an 'auth:force_disconnect' event with the suspension
   * details before the socket is closed, allowing the frontend to show a
   * user-facing "Account Suspended" message.
   */
  private async forceDisconnectUser(
    userId: number,
    payload: ForceDisconnectPayload,
  ): Promise<void> {
    const socketIds = await this.userSocketRepo.getSocketIds(userId);
    let disconnectedCount = 0;

    for (const sid of socketIds) {
      const socket = this.io.sockets.sockets.get(sid);
      if (socket) {
        // Emit before disconnect so the client can react (show suspended page)
        socket.emit("auth:force_disconnect", payload);
        socket.disconnect(true);
        disconnectedCount++;
      }
    }

    this.logger.warn(
      {
        userId,
        socketCount: socketIds.length,
        disconnectedCount,
        reason: payload.reason,
      },
      "User force-disconnected from all sockets",
    );
  }
}
