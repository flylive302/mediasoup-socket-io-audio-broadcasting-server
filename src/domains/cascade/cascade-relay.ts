/**
 * Cascade Relay — HTTP-based signaling relay for cross-region Socket.IO events
 *
 * When a socket event is emitted in a room that spans multiple regions,
 * the relay forwards the event to all remote instances so their local
 * users see it. This handles chat, seat changes, user joins/leaves, etc.
 *
 * The relay prevents loops via sourceInstanceId — each relay call
 * includes the originator's ID so the receiving instance doesn't
 * re-relay back to it.
 */
import { config } from "@src/config/index.js";
import type { Logger } from "@src/infrastructure/logger.js";
import type { RemoteInstance, RelayPayload } from "./types.js";

export class CascadeRelay {
  /** roomId → set of remote instances (edges if we're origin, origin if we're edge) */
  private readonly remoteInstances = new Map<string, Map<string, RemoteInstance>>();

  /** Our own instance ID (PUBLIC_IP) used in sourceInstanceId to prevent loops */
  private readonly selfId: string;

  constructor(private readonly logger: Logger) {
    this.selfId = config.PUBLIC_IP || "unknown";
  }

  // ─── Registration ─────────────────────────────────────────────

  /**
   * Register a remote instance for a room.
   * Called when an edge setup completes for a room.
   */
  registerRemote(roomId: string, instance: RemoteInstance): void {
    let instances = this.remoteInstances.get(roomId);
    if (!instances) {
      instances = new Map();
      this.remoteInstances.set(roomId, instances);
    }
    instances.set(instance.instanceId, instance);
    this.logger.debug(
      { roomId, instanceId: instance.instanceId, baseUrl: instance.baseUrl },
      "CascadeRelay: remote instance registered",
    );
  }

  /**
   * Unregister a remote instance for a room.
   * Called when an edge disconnects or room closes.
   */
  unregisterRemote(roomId: string, instanceId: string): void {
    const instances = this.remoteInstances.get(roomId);
    if (instances) {
      instances.delete(instanceId);
      if (instances.size === 0) {
        this.remoteInstances.delete(roomId);
      }
    }
    this.logger.debug(
      { roomId, instanceId },
      "CascadeRelay: remote instance unregistered",
    );
  }

  /**
   * Check if a room has any remote instances.
   */
  hasRemotes(roomId: string): boolean {
    const instances = this.remoteInstances.get(roomId);
    return instances !== undefined && instances.size > 0;
  }

  /**
   * Clean up all remote registrations for a room.
   */
  cleanupRoom(roomId: string): void {
    this.remoteInstances.delete(roomId);
  }

  // ─── Relay ────────────────────────────────────────────────────

  /**
   * Relay a socket event to all remote instances for this room.
   * Skips the instance identified by excludeInstanceId (the source of the event).
   */
  async relayToRemote(
    roomId: string,
    event: string,
    data: unknown,
    excludeInstanceId?: string,
  ): Promise<void> {
    const instances = this.remoteInstances.get(roomId);
    if (!instances || instances.size === 0) return;

    const payload: RelayPayload = {
      roomId,
      event,
      data,
      sourceInstanceId: this.selfId,
    };

    const promises: Promise<void>[] = [];

    for (const [instanceId, instance] of instances) {
      // Don't relay back to source
      if (instanceId === excludeInstanceId) continue;

      promises.push(this.sendRelay(instance, payload));
    }

    // Fire-and-forget — don't block the handler on relay completion
    await Promise.allSettled(promises);
  }

  // ─── Private ──────────────────────────────────────────────────

  private async sendRelay(
    instance: RemoteInstance,
    payload: RelayPayload,
  ): Promise<void> {
    const url = `${instance.baseUrl}/internal/cascade/relay`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_API_KEY || "",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            {
              instanceId: instance.instanceId,
              status: response.status,
              event: payload.event,
              roomId: payload.roomId,
            },
            "CascadeRelay: relay request failed",
          );
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.logger.warn(
        {
          err,
          instanceId: instance.instanceId,
          event: payload.event,
          roomId: payload.roomId,
        },
        "CascadeRelay: relay request error",
      );
    }
  }
}
