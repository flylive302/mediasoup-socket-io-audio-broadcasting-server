import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoCloseService } from "@src/domains/room/auto-close/index.js";
import { PresenceTracker } from "@src/domains/room/presence-tracker.js";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";

const ROOM = "candidate-room";

/**
 * Mock Redis covering only what the candidate pre-filter touches:
 * SCAN room:state:* then a pipeline of EXISTS(activity) per room.
 * Here the room is always a candidate: activity expired. (msab-load-stability
 * 09: the advisory participantCount no longer gates candidacy — the GET leg
 * of the old pipeline is kept in the mock only to prove it isn't consulted.)
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
  const reconcileParticipantCount = vi.fn(async (_r: string, c: number) => c);
  const state = {
    reconcileParticipantCount,
  } as unknown as RoomStateRepository;
  return { tracker: new PresenceTracker(io, state), reconcileParticipantCount };
}

describe("AutoCloseService — presence gates the close decision (Cause B)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a candidate that real presence shows is STILL OCCUPIED is never closed", async () => {
    // The advisory integer drifted to 0, but a socket is genuinely present.
    const service = new AutoCloseService(mockRedis(), trackerWithPresence(1).tracker);
    expect(await service.getInactiveRoomIds()).toEqual([]);
  });

  it("a genuinely-empty candidate is held by the grace window, then closed", async () => {
    const service = new AutoCloseService(mockRedis(), trackerWithPresence(0).tracker);

    // First poll: presence just observed at zero → grace not elapsed → keep.
    vi.setSystemTime(0);
    expect(await service.getInactiveRoomIds()).toEqual([]);

    // A later poll, past the grace window → close.
    vi.setSystemTime(30_000);
    expect(await service.getInactiveRoomIds()).toEqual([ROOM]);
  });

  it("crash-orphan: stale advisory count > 0 no longer blocks the reap (msab-load-stability 09)", async () => {
    // The owning instance crashed: no disconnect handlers ran, no heartbeat
    // survives to heal participantCount. room:state still says 3 participants,
    // but zero sockets exist fleet-wide. Candidacy is activity-TTL-only, so the
    // room is admitted, presence confirms empty, and after grace it closes.
    const redisWithStaleCount = {
      scan: vi.fn(async () => ["0", [`room:state:${ROOM}`]]),
      pipeline: () => {
        const ops: string[] = [];
        const p = {
          exists: () => (ops.push("exists"), p),
          get: () => (ops.push("get"), p),
          exec: async () =>
            ops.map((op) =>
              op === "exists"
                ? [null, 0] // activity key expired
                : [null, JSON.stringify({ participantCount: 3 })], // stale — must be ignored
            ),
        };
        return p;
      },
    } as unknown as Redis;

    const { tracker, reconcileParticipantCount } = trackerWithPresence(0);
    const service = new AutoCloseService(redisWithStaleCount, tracker);

    vi.setSystemTime(0);
    expect(await service.getInactiveRoomIds()).toEqual([]); // grace holds first
    vi.setSystemTime(30_000);
    expect(await service.getInactiveRoomIds()).toEqual([ROOM]);

    // The sweep itself healed the advisory integer fleet-wide (not the dead
    // instance's heartbeat).
    expect(reconcileParticipantCount).toHaveBeenCalledWith(ROOM, 0);
  });

  it("reconnect blip: an occupied observation clears the grace timer — no close on a later transient zero", async () => {
    let present = 0;
    const io = {
      in: () => ({
        fetchSockets: async () => Array.from({ length: present }, (_, i) => ({ id: `s${i}` })),
      }),
    } as unknown as Server;
    const state = {
      reconcileParticipantCount: vi.fn(async (_r: string, c: number) => c),
    } as unknown as RoomStateRepository;
    const service = new AutoCloseService(mockRedis(), new PresenceTracker(io, state));

    vi.setSystemTime(0);
    expect(await service.getInactiveRoomIds()).toEqual([]); // zero observed, grace starts

    present = 2; // everyone reconnected
    vi.setSystemTime(20_000);
    expect(await service.getInactiveRoomIds()).toEqual([]); // occupied → grace cleared

    present = 0; // fresh transient zero
    vi.setSystemTime(25_000);
    expect(await service.getInactiveRoomIds()).toEqual([]); // grace restarts — no close
  });
});
