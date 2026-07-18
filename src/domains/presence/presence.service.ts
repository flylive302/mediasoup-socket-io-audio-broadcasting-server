/**
 * DM Presence — connection-count presence keyed per-user in shared Redis.
 *
 * dm-realtime-platform/07 (Fable design, binding). Presence is derived purely
 * from Socket.IO connection lifecycle, never a client heartbeat:
 *
 * - connect:    INCR presence:conn:{userId} + EXPIRE (TTL). 0→1 transition
 *               (INCR result === 1) emits `presence.update {online:true}`.
 * - disconnect: DECR presence:conn:{userId}. Result <= 0 → DEL + emit
 *               `presence.update {online:false}`.
 * - sweep:      every SWEEP_INTERVAL_MS, each instance re-EXPIREs the keys of
 *               users with sockets currently connected to it (ClientManager),
 *               so the TTL never lapses under a live connection. This is the
 *               ONLY heartbeat — no client-side timer, zero battery cost.
 *
 * Ungraceful drops (crashed instance, never runs disconnect) are covered by
 * TTL expiry: the key silently disappears, no `offline` push fires for that
 * path, and subscribers self-heal via the `presence:subscribe` snapshot
 * (EXISTS-based, so a lapsed key already reads offline).
 *
 * Multi-socket (multi-tab / multi-device) is handled naturally by the
 * INCR/DECR arithmetic — N connected sockets for a user hold the counter at
 * N, and only the Nth disconnect (last socket) drops it to 0 and emits
 * offline. connectionStateRecovery is disabled fleet-wide (see
 * src/infrastructure/server.ts), so every reconnect is a fresh socket.id —
 * there is no resume path that could double-count a single logical session.
 */
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import { logger } from "@src/infrastructure/logger.js";
import { config } from "@src/config/index.js";
import type { ClientManager } from "@src/client/clientManager.js";

export function presenceUserRoom(userId: number): string {
  return `presence:user:${userId}`;
}

function presenceConnKey(userId: number): string {
  return `presence:conn:${userId}`;
}

export class PresenceService {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly io: Server,
    private readonly clientManager: ClientManager,
  ) {}

  /**
   * EXECUTE: connection lifecycle — a new socket for this user came up.
   * REACT: emits `presence.update {online:true}` on the 0→1 transition only.
   */
  async onConnect(userId: number): Promise<void> {
    try {
      const count = await this.redis.incr(presenceConnKey(userId));
      await this.redis.expire(presenceConnKey(userId), config.PRESENCE_TTL_SECONDS);

      if (count === 1) {
        this.emitTransition(userId, true);
      }
    } catch (err) {
      logger.error({ err, userId }, "presence.onConnect failed");
    }
  }

  /**
   * EXECUTE: connection lifecycle — a socket for this user went away.
   * REACT: emits `presence.update {online:false}` once the counter reaches 0.
   */
  async onDisconnect(userId: number): Promise<void> {
    try {
      const count = await this.redis.decr(presenceConnKey(userId));

      if (count <= 0) {
        await this.redis.del(presenceConnKey(userId));
        this.emitTransition(userId, false);
      }
    } catch (err) {
      logger.error({ err, userId }, "presence.onDisconnect failed");
    }
  }

  /**
   * GATE-free read: batch presence snapshot for a subscribe request.
   */
  async snapshot(userIds: number[]): Promise<Record<number, boolean>> {
    if (userIds.length === 0) return {};

    const pipeline = this.redis.pipeline();
    for (const userId of userIds) {
      pipeline.exists(presenceConnKey(userId));
    }
    const results = await pipeline.exec();

    const out: Record<number, boolean> = {};
    userIds.forEach((userId, i) => {
      const value = results?.[i]?.[1];
      out[userId] = value === 1;
    });
    return out;
  }

  private emitTransition(userId: number, online: boolean): void {
    this.io.to(presenceUserRoom(userId)).emit("presence.update", {
      userId,
      online,
    });
  }

  /**
   * Start the per-instance TTL-refresh sweep: every SWEEP_INTERVAL_MS,
   * re-EXPIRE the presence key of every user with at least one socket
   * connected to THIS instance (ClientManager is instance-local). Mirrors
   * AutoCloseJob's start/stop interval pattern.
   */
  start(): void {
    if (this.sweepTimer) {
      logger.warn("Presence sweep already running");
      return;
    }

    this.sweepTimer = setInterval(
      () => void this.sweep(),
      config.PRESENCE_SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref?.();

    logger.info(
      { sweepIntervalMs: config.PRESENCE_SWEEP_INTERVAL_MS },
      "Presence sweep started",
    );
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      logger.info("Presence sweep stopped");
    }
  }

  private async sweep(): Promise<void> {
    try {
      const userIds = this.clientManager.getConnectedUserIds();
      if (userIds.length === 0) return;

      const pipeline = this.redis.pipeline();
      for (const userId of userIds) {
        pipeline.expire(presenceConnKey(userId), config.PRESENCE_TTL_SECONDS);
      }
      await pipeline.exec();
    } catch (err) {
      logger.error({ err }, "Presence sweep failed");
    }
  }
}
