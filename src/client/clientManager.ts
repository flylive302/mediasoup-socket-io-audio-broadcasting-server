import type { Socket } from "socket.io";
import type { User } from "@src/auth/types.js";

export interface ClientData {
  socketId: string;
  userId: number;
  user: User;
  roomId?: string;
  isSpeaker: boolean;
  joinedAt: number;
  device?: object;
  // Mediasoup tracking
  // dj-talk-over/01: keyed by `source` ("mic" | "music"), not mediasoup `kind`
  // — both audio kinds are "audio", so keying by kind let a music producer
  // silently overwrite the mic entry. Re-keyed so mic + music coexist.
  producers: Map<string, string>; // source -> producerId
  consumers: Map<string, string>; // producerId -> consumerId
  transports: Map<string, string>; // transportId -> type
}

export class ClientManager {
  private readonly clients = new Map<string, ClientData>();
  /** PERF-006: Room-indexed secondary structure for O(1) room lookup */
  private readonly roomClients = new Map<string, Set<string>>(); // roomId → socketIds

  addClient(socket: Socket): void {
    if (!socket.data?.user) {
      throw new Error("Cannot add client: socket.data.user is missing (auth middleware may have been bypassed)");
    }
    const user = socket.data.user as User;

    this.clients.set(socket.id, {
      socketId: socket.id,
      userId: user.id,
      user,
      isSpeaker: false,
      joinedAt: Date.now(),
      producers: new Map(),
      consumers: new Map(),
      transports: new Map(),
    });
  }

  /**
   * Remove a client.
   *
   * F-41: a `connectionStateRecovery` resume re-runs `io.on("connection")` and
   * calls `addClient` with the SAME socket.id while the original disconnect
   * handler is still draining asynchronously. If `expected` is supplied, the
   * delete only happens when the live entry is still the exact object the
   * caller captured — a fresh `addClient` allocates a new ClientData, so a
   * stale disconnect cannot clobber the recovered session.
   */
  removeClient(socketId: string, expected?: ClientData): void {
    const client = this.clients.get(socketId);
    if (expected !== undefined && client !== expected) return;
    if (client?.roomId) {
      const roomSet = this.roomClients.get(client.roomId);
      if (roomSet) {
        roomSet.delete(socketId);
        if (roomSet.size === 0) this.roomClients.delete(client.roomId);
      }
    }
    this.clients.delete(socketId);
  }

  getClient(socketId: string): ClientData | undefined {
    return this.clients.get(socketId);
  }

  /**
   * Distinct user ids with at least one socket connected to THIS instance.
   * dm-realtime-platform/07: drives the presence sweep's per-instance
   * re-EXPIRE — ClientManager tracking is instance-local by design, so each
   * MSAB instance only refreshes TTLs for users it actually holds sockets for.
   */
  getConnectedUserIds(): number[] {
    const userIds = new Set<number>();
    for (const client of this.clients.values()) {
      userIds.add(client.userId);
    }
    return [...userIds];
  }

  /**
   * Update client's room and maintain the room index.
   * PERF-006: Must be called instead of directly setting client.roomId
   */
  setClientRoom(socketId: string, roomId: string): void {
    const client = this.clients.get(socketId);
    if (!client) return;

    // Remove from old room index
    if (client.roomId) {
      const oldSet = this.roomClients.get(client.roomId);
      if (oldSet) {
        oldSet.delete(socketId);
        if (oldSet.size === 0) this.roomClients.delete(client.roomId);
      }
    }

    // Reset mediasoup tracking — old transports/producers/consumers belong to
    // the previous room session and are invalid for new room routers.
    // Without this, transport:create rejects with "Transport limit reached"
    // when the user re-joins or switches rooms without explicit room:leave.
    client.transports.clear();
    client.producers.clear();
    client.consumers.clear();
    client.isSpeaker = false;

    // Set new room
    client.roomId = roomId;

    // Add to new room index
    let roomSet = this.roomClients.get(roomId);
    if (!roomSet) {
      roomSet = new Set();
      this.roomClients.set(roomId, roomSet);
    }
    roomSet.add(socketId);
  }

  /**
   * Clear client's room assignment and remove from room index.
   * ROOM-BL-002 FIX: Used on explicit room:leave (client stays connected but leaves room)
   */
  clearClientRoom(socketId: string): void {
    const client = this.clients.get(socketId);
    if (!client?.roomId) return;

    const roomSet = this.roomClients.get(client.roomId);
    if (roomSet) {
      roomSet.delete(socketId);
      if (roomSet.size === 0) this.roomClients.delete(client.roomId);
    }
    delete client.roomId;

    // Reset mediasoup tracking — old transports/producers/consumers belong to
    // the previous room session. Without this, transport:create rejects with
    // "Transport limit reached" when the user rejoins.
    client.transports.clear();
    client.producers.clear();
    client.consumers.clear();
    client.isSpeaker = false;
  }

  /**
   * Get all clients in a specific room.
   * PERF-006: O(roomSize) instead of O(totalClients)
   */
  getClientsInRoom(roomId: string): ClientData[] {
    const socketIds = this.roomClients.get(roomId);
    if (!socketIds) return [];
    const result: ClientData[] = [];
    for (const sid of socketIds) {
      const client = this.clients.get(sid);
      if (client) result.push(client);
    }
    return result;
  }

  /**
   * Resolve a user's socket id(s) **within a specific room**.
   *
   * Used for targeted, room-scoped delivery (e.g. the owner force-take's
   * `audioPlayer:revoked`, which must reach exactly the displaced DJ's sockets
   * in this room and never leak to other participants). A user may have
   * multiple sockets (multi-device); all that are in `roomId` are returned.
   */
  getSocketIdsByUserInRoom(userId: number, roomId: string): string[] {
    const socketIds = this.roomClients.get(roomId);
    if (!socketIds) return [];
    const result: string[] = [];
    for (const sid of socketIds) {
      const client = this.clients.get(sid);
      if (client?.userId === userId) result.push(sid);
    }
    return result;
  }

  /**
   * Update in-memory user profile for all sockets belonging to a user.
   * Called when `user.profile.updated` event is received from Laravel.
   * Returns the set of room IDs the user is currently in (for broadcasting).
   */
  updateUserProfile(
    userId: number,
    profile: Partial<User>,
  ): Set<string> {
    const affectedRooms = new Set<string>();

    for (const client of this.clients.values()) {
      if (client.userId === userId) {
        // Merge profile into existing user data (profile from Laravel is authoritative)
        client.user = { ...client.user, ...profile };

        if (client.roomId) {
          affectedRooms.add(client.roomId);
        }
      }
    }

    return affectedRooms;
  }
}
