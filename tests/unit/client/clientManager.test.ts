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

  // ─── setClientRoom: mediasoup tracking reset ─────────────────────

  it("setClientRoom clears transport/producer/consumer tracking", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    cm.setClientRoom("s1", "roomA");

    // Simulate stale transports from old room session
    const client = cm.getClient("s1")!;
    client.transports.set("t1", "consumer");
    client.transports.set("t2", "producer");
    client.producers.set("audio", "p1");
    client.consumers.set("p1", "c1");
    client.isSpeaker = true;

    // Re-assign to new room — should reset tracking
    cm.setClientRoom("s1", "roomB");

    expect(client.transports.size).toBe(0);
    expect(client.producers.size).toBe(0);
    expect(client.consumers.size).toBe(0);
    expect(client.isSpeaker).toBe(false);
    expect(client.roomId).toBe("roomB");
  });

  it("setClientRoom clears tracking even when re-joining same room", () => {
    const cm = new ClientManager();
    cm.addClient(createMockSocket("s1", 1));
    cm.setClientRoom("s1", "roomA");

    const client = cm.getClient("s1")!;
    client.transports.set("t1", "consumer");
    client.transports.set("t2", "producer");

    // Re-join same room
    cm.setClientRoom("s1", "roomA");

    expect(client.transports.size).toBe(0);
    expect(client.roomId).toBe("roomA");
  });

  // ─── F-41: removeClient identity guard ────────────────────────────

  describe("removeClient (F-41 identity guard)", () => {
    it("skips the delete when `expected` does not match the live client", () => {
      const cm = new ClientManager();
      const sock = createMockSocket("s1", 1);
      cm.addClient(sock);
      const stale = cm.getClient("s1")!;

      // Simulate connectionStateRecovery: a fresh addClient overwrites the
      // ClientData under the same socket.id. The stale disconnect handler
      // (which captured the original `stale` ref) must NOT delete the fresh
      // entry — otherwise the recovered session loses its tracking.
      cm.addClient(sock);
      const fresh = cm.getClient("s1")!;
      expect(fresh).not.toBe(stale);

      cm.removeClient("s1", stale);
      expect(cm.getClient("s1")).toBe(fresh);
    });

    it("deletes when `expected` matches the live client (normal disconnect)", () => {
      const cm = new ClientManager();
      const sock = createMockSocket("s1", 1);
      cm.addClient(sock);
      const live = cm.getClient("s1")!;

      cm.removeClient("s1", live);
      expect(cm.getClient("s1")).toBeUndefined();
    });

    it("falls back to unconditional delete when no `expected` is passed", () => {
      const cm = new ClientManager();
      const sock = createMockSocket("s1", 1);
      cm.addClient(sock);
      cm.removeClient("s1");
      expect(cm.getClient("s1")).toBeUndefined();
    });
  });

  // ─── updateUserProfile — equipped_badges replace ─────────────────────────────

  describe("updateUserProfile — equipped_badges", () => {
    it("replaces equipped_badges array (not deep-merge) when profile carries the field", () => {
      const cm = new ClientManager();
      const sock = createMockSocket("s1", 42);
      cm.addClient(sock);

      const initial = [{ slot_position: 1, badge_id: 10, image_url: "https://cdn/b10.png" }];
      const updated = [
        { slot_position: 1, badge_id: 20, image_url: "https://cdn/b20.png" },
        { slot_position: 2, badge_id: 30, image_url: null },
      ];

      // Seed initial equipped_badges
      cm.updateUserProfile(42, { equipped_badges: initial } as Parameters<typeof cm.updateUserProfile>[1]);
      expect(cm.getClient("s1")!.user.equipped_badges).toEqual(initial);

      // Replace with a different array — must not deep-merge
      cm.updateUserProfile(42, { equipped_badges: updated } as Parameters<typeof cm.updateUserProfile>[1]);
      expect(cm.getClient("s1")!.user.equipped_badges).toEqual(updated);
      expect(cm.getClient("s1")!.user.equipped_badges).toHaveLength(2);
    });

    it("returns the set of rooms the user is in", () => {
      const cm = new ClientManager();
      cm.addClient(createMockSocket("s1", 42));
      cm.setClientRoom("s1", "roomA");

      const rooms = cm.updateUserProfile(42, { name: "Updated" });
      expect(rooms.has("roomA")).toBe(true);
    });
  });
});
