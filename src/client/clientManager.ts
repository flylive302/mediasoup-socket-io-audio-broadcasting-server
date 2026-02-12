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
  producers: Map<string, string>; // kind -> producerId
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

  removeClient(socketId: string): void {
    const client = this.clients.get(socketId);
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
}
