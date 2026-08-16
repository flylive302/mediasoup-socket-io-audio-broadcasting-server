import { describe, it, expect, vi, beforeEach } from "vitest";
import { PresenceTracker } from "@src/domains/room/presence-tracker.js";
import type { Server } from "socket.io";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";

// ── Mock io: io.in(room).fetchSockets() → configurable socket array ──
// aws-production/19: also models `.local.fetchSockets()` (adapter-local, no
// Redis fan-out) with its own socket set + call counters, so tests can prove
// which path answered.
function createMockIo() {
  const roomSockets = new Map<string, unknown[]>();
  const localSockets = new Map<string, unknown[]>();
  const calls = { cross: 0, local: 0 };
  const io = {
    in: (roomId: string) => ({
      fetchSockets: async () => {
        calls.cross++;
        return roomSockets.get(roomId) ?? [];
      },
      local: {
        fetchSockets: async () => {
          calls.local++;
          return localSockets.get(roomId) ?? [];
        },
      },
    }),
  } as unknown as Server;
  return {
    io,
    calls,
    setSockets: (roomId: string, n: number) =>
      roomSockets.set(roomId, Array.from({ length: n }, (_, i) => ({ id: `s${i}` }))),
    setLocalSockets: (roomId: string, n: number) =>
      localSockets.set(roomId, Array.from({ length: n }, (_, i) => ({ id: `l${i}` }))),
  };
}

function createMockState() {
  return {
    reconcileParticipantCount: vi.fn(async (_roomId: string, count: number) => count),
  } as unknown as RoomStateRepository & {
    reconcileParticipantCount: ReturnType<typeof vi.fn>;
  };
}

describe("PresenceTracker", () => {
  let mockIo: ReturnType<typeof createMockIo>;
  let state: ReturnType<typeof createMockState>;
  let tracker: PresenceTracker;

  beforeEach(() => {
    mockIo = createMockIo();
    state = createMockState();
    tracker = new PresenceTracker(mockIo.io, state);
  });

  describe("present / isEmpty — real socket membership is the source of truth", () => {
    it("returns the live socket count", async () => {
      mockIo.setSockets("r1", 3);
      expect(await tracker.present("r1")).toBe(3);
      expect(await tracker.isEmpty("r1")).toBe(false);
    });

    it("an unknown/empty room reports zero present", async () => {
      expect(await tracker.present("ghost")).toBe(0);
      expect(await tracker.isEmpty("ghost")).toBe(true);
    });
  });

  describe("grace bookkeeping (observe / getZeroSince)", () => {
    it("starts the zero timer on the first empty observation", () => {
      expect(tracker.getZeroSince("r1")).toBeNull();
      tracker.observe("r1", 0, 1000);
      expect(tracker.getZeroSince("r1")).toBe(1000);
    });

    it("keeps the ORIGINAL zero timestamp across repeated empties (never under-counts the grace)", () => {
      tracker.observe("r1", 0, 1000);
      tracker.observe("r1", 0, 5000);
      expect(tracker.getZeroSince("r1")).toBe(1000);
    });

    it("a non-empty observation clears the zero timer (reconnect heals the grace)", () => {
      tracker.observe("r1", 0, 1000);
      tracker.observe("r1", 2, 2000);
      expect(tracker.getZeroSince("r1")).toBeNull();
    });

    it("forget() drops bookkeeping so the map cannot leak after close", () => {
      tracker.observe("r1", 0, 1000);
      tracker.forget("r1");
      expect(tracker.getZeroSince("r1")).toBeNull();
    });
  });

  describe("reconcile — heal the advisory integer to real presence", () => {
    it("writes the live presence count to room:state and returns it", async () => {
      mockIo.setSockets("r1", 4);
      const result = await tracker.reconcile("r1");
      expect(result).toBe(4);
      expect(state.reconcileParticipantCount).toHaveBeenCalledWith("r1", 4);
    });

    it("reconciles an emptied room to zero (so it becomes an auto-close candidate)", async () => {
      const result = await tracker.reconcile("emptied");
      expect(result).toBe(0);
      expect(state.reconcileParticipantCount).toHaveBeenCalledWith("emptied", 0);
    });

    it("tolerates a missing room:state key (Lua returns null → no throw, no resurrect)", async () => {
      state.reconcileParticipantCount.mockResolvedValueOnce(null);
      mockIo.setSockets("r1", 0);
      await expect(tracker.reconcile("r1")).resolves.toBe(0);
    });

    it("feeds the grace timer: repopulation clears zeroSince, re-emptying restarts it from the NEW time", async () => {
      vi.useFakeTimers();
      try {
        // Empty → grace timer starts.
        vi.setSystemTime(1000);
        mockIo.setSockets("r1", 0);
        await tracker.reconcile("r1");
        expect(tracker.getZeroSince("r1")).toBe(1000);

        // Repopulated → timer cleared (a stale zeroSince here is the bug this guards).
        vi.setSystemTime(2000);
        mockIo.setSockets("r1", 2);
        await tracker.reconcile("r1");
        expect(tracker.getZeroSince("r1")).toBeNull();

        // Empty again → grace restarts from now (5000), not the ancient 1000.
        vi.setSystemTime(5000);
        mockIo.setSockets("r1", 0);
        await tracker.reconcile("r1");
        expect(tracker.getZeroSince("r1")).toBe(5000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("local-first presence under affinity (aws-production/19)", () => {
    it("a non-zero LOCAL answer is complete — no cross-fleet fan-out", async () => {
      const local = new PresenceTracker(mockIo.io, state, () => true);
      mockIo.setLocalSockets("r1", 3);
      mockIo.setSockets("r1", 99); // would be wrong to consult

      await expect(local.present("r1")).resolves.toBe(3);
      expect(mockIo.calls.local).toBe(1);
      expect(mockIo.calls.cross).toBe(0);
    });

    it("a LOCAL zero is verified cross-fleet — never a confidently wrong empty", async () => {
      const local = new PresenceTracker(mockIo.io, state, () => true);
      mockIo.setLocalSockets("r1", 0);
      mockIo.setSockets("r1", 2); // rollout stragglers on another instance

      await expect(local.present("r1")).resolves.toBe(2);
      expect(mockIo.calls.local).toBe(1);
      expect(mockIo.calls.cross).toBe(1);
    });

    it("a failed local read degrades to the cross-fleet helper", async () => {
      const failingIo = {
        in: () => ({
          fetchSockets: async () => [{ id: "s0" }],
          local: {
            fetchSockets: async () => {
              throw new Error("adapter down");
            },
          },
        }),
      } as unknown as Server;
      const local = new PresenceTracker(failingIo, state, () => true);

      await expect(local.present("r1")).resolves.toBe(1);
    });

    it("affinity OFF keeps the region-wide path untouched", async () => {
      const off = new PresenceTracker(mockIo.io, state, () => false);
      mockIo.setLocalSockets("r1", 3);
      mockIo.setSockets("r1", 7);

      await expect(off.present("r1")).resolves.toBe(7);
      expect(mockIo.calls.local).toBe(0);
    });
  });
});
