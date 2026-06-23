import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoCloseService } from "@src/domains/room/auto-close/index.js";
import { PresenceTracker } from "@src/domains/room/presence-tracker.js";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";

const ROOM = "candidate-room";

/**
 * Mock Redis covering only what the candidate pre-filter touches:
 * SCAN room:state:* then a pipeline of EXISTS(activity)+GET(state) per room.
 * Here the room is always a candidate: activity expired + advisory count 0.
 */
function mockRedis(): Redis {
  return {
    scan: vi.fn(async () => ["0", [`room:state:${ROOM}`]]),
    pipeline: () => {
      const ops: Array<[string, string]> = [];
      const p = {
        exists: (k: string) => {
          ops.push(["exists", k]);
          return p;
        },
        get: (k: string) => {
          ops.push(["get", k]);
          return p;
        },
        exec: async () =>
          ops.map(([op]) =>
            op === "exists"
              ? [null, 0] // activity key expired → candidate
              : [null, JSON.stringify({ participantCount: 0 })], // advisory count 0
          ),
      };
      return p;
    },
  } as unknown as Redis;
}

function trackerWithPresence(present: number) {
  const io = {
    in: () => ({
      fetchSockets: async () => Array.from({ length: present }, (_, i) => ({ id: `s${i}` })),
    }),
  } as unknown as Server;
  const state = {
    reconcileParticipantCount: vi.fn(async (_r: string, c: number) => c),
  } as unknown as RoomStateRepository;
  return new PresenceTracker(io, state);
}

describe("AutoCloseService — presence gates the close decision (Cause B)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a candidate that real presence shows is STILL OCCUPIED is never closed", async () => {
    // The advisory integer drifted to 0, but a socket is genuinely present.
    const service = new AutoCloseService(mockRedis(), trackerWithPresence(1));
    expect(await service.getInactiveRoomIds()).toEqual([]);
  });

  it("a genuinely-empty candidate is held by the grace window, then closed", async () => {
    const service = new AutoCloseService(mockRedis(), trackerWithPresence(0));

    // First poll: presence just observed at zero → grace not elapsed → keep.
    vi.setSystemTime(0);
    expect(await service.getInactiveRoomIds()).toEqual([]);

    // A later poll, past the grace window → close.
    vi.setSystemTime(30_000);
    expect(await service.getInactiveRoomIds()).toEqual([ROOM]);
  });
});
