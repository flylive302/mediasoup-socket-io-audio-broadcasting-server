import type { Socket } from "socket.io";
import type { User } from "../auth/types.js";

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
    this.clients.delete(socketId);
  }

  getClient(socketId: string): ClientData | undefined {
    return this.clients.get(socketId);
  }

  /**
   * Get all clients in a specific room.
   * Used to send initial state when a user joins.
   */
  getClientsInRoom(roomId: string): ClientData[] {
    const clients: ClientData[] = [];
    for (const client of this.clients.values()) {
      if (client.roomId === roomId) {
        clients.push(client);
      }
    }
    return clients;
  }
}
