import { describe, it, expect } from "vitest";
import { ClientManager } from "@src/client/clientManager.js";
import type { Socket } from "socket.io";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockSocket(
  id: string,
  userId: number,
  name = "TestUser",
): Socket {
  return {
    id,
    data: {
      user: {
        id: userId,
        name,
        email: `${name.toLowerCase()}@test.com`,
        avatar: "https://example.com/avatar.jpg",
        frame: "gold",
        gender: "male",
        signature: "1234567",
        date_of_birth: "1990-01-01",
        phone: "+1234567890",
        country: "US",
        coins: "1000",
        diamonds: "500",
        wealth_xp: "2500",
        charm_xp: "1200",
        is_blocked: false,
        isSpeaker: false,
      },
    },
  } as unknown as Socket;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("ClientManager", () => {
  // ─── addClient / getClient ──────────────────────────────────────

  it("adds and retrieves a client", () => {
    const cm = new ClientManager();
    const socket = createMockSocket("s1", 42);

    cm.addClient(socket);
    const client = cm.getClient("s1");

    expect(client).toBeDefined();
    expect(client!.socketId).toBe("s1");
    expect(client!.userId).toBe(42);
    expect(client!.isSpeaker).toBe(false);
  });

  it("throws if socket.data.user is missing", () => {
    const cm = new ClientManager();
    const socket = { id: "s1", data: {} } as unknown as Socket;

    expect(() => cm.addClient(socket)).toThrow("socket.data.user is missing");
  });

  // ─── removeClient ──────────────────────────────────────────────

  it("removes a client", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 42));

    cm.removeClient("s1");
    expect(cm.getClient("s1")).toBeUndefined();
  });

  it("cleans up room index when client is removed", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 42));
    cm.setClientRoom("s1", "room1");

    cm.removeClient("s1");
    expect(cm.getClientsInRoom("room1")).toHaveLength(0);
  });

  // ─── PERF-006: setClientRoom + getClientsInRoom ─────────────────

  it("indexes clients by room for O(1) lookup", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    cm.addClient(createMockSocket("s2", 2));
    cm.addClient(createMockSocket("s3", 3));

    cm.setClientRoom("s1", "roomA");
    cm.setClientRoom("s2", "roomA");
    cm.setClientRoom("s3", "roomB");

    const roomA = cm.getClientsInRoom("roomA");
    const roomB = cm.getClientsInRoom("roomB");

    expect(roomA).toHaveLength(2);
    expect(roomA.map((c) => c.userId).sort()).toEqual([1, 2]);
    expect(roomB).toHaveLength(1);
    expect(roomB[0]!.userId).toBe(3);
  });

  it("returns empty array for unknown room", () => {
    const cm = new ClientManager();
    expect(cm.getClientsInRoom("nonexistent")).toEqual([]);
  });

  it("moves client to new room (cleans up old room index)", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));

    cm.setClientRoom("s1", "roomA");
    expect(cm.getClientsInRoom("roomA")).toHaveLength(1);

    cm.setClientRoom("s1", "roomB");
    expect(cm.getClientsInRoom("roomA")).toHaveLength(0);
    expect(cm.getClientsInRoom("roomB")).toHaveLength(1);
  });

  it("deletes room set when last client leaves", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    cm.setClientRoom("s1", "roomA");

    cm.removeClient("s1");

    // Internal room set should be cleaned up (verify via getClientsInRoom)
    expect(cm.getClientsInRoom("roomA")).toEqual([]);
  });

  it("handles setClientRoom for non-existent client gracefully", () => {
    const cm = new ClientManager();
    // Should not throw
    cm.setClientRoom("nonexistent", "roomA");
    expect(cm.getClientsInRoom("roomA")).toEqual([]);
  });

  it("handles removing non-existent client gracefully", () => {
    const cm = new ClientManager();
    // Should not throw
    cm.removeClient("nonexistent");
  });

  // ─── Multiple clients same room ──────────────────────────────────

  it("handles many clients in the same room", () => {
    const cm = new ClientManager();
    const count = 50;

    for (let i = 0; i < count; i++) {
      cm.addClient(createMockSocket(`s${i}`, i));
      cm.setClientRoom(`s${i}`, "bigRoom");
    }

    expect(cm.getClientsInRoom("bigRoom")).toHaveLength(count);

    // Remove half
    for (let i = 0; i < count / 2; i++) {
      cm.removeClient(`s${i}`);
    }
    expect(cm.getClientsInRoom("bigRoom")).toHaveLength(count / 2);
  });

  // ─── clearClientRoom ─────────────────────────────────────────

  it("clearClientRoom removes client from room index", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    cm.setClientRoom("s1", "roomA");

    cm.clearClientRoom("s1");
    expect(cm.getClientsInRoom("roomA")).toHaveLength(0);
  });

  it("clearClientRoom sets roomId to undefined", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    cm.setClientRoom("s1", "roomA");

    cm.clearClientRoom("s1");
    expect(cm.getClient("s1")!.roomId).toBeUndefined();
  });

  it("clearClientRoom is no-op for client without room", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    // Should not throw
    cm.clearClientRoom("s1");
    expect(cm.getClient("s1")).toBeDefined();
  });
});
