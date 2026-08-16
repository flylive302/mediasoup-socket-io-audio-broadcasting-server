/**
 * aws-production/19 — the auto-close sweep scopes to Rooms this instance owns.
 *
 * Affinity ON + local registry wired: Phase-1 candidacy comes from the local
 * rooms map (no keyspace SCAN); the fleet SCAN survives only as the paced
 * orphan safety net (every 10th sweep, admitting ONLY ownerless rooms so a
 * crashed instance's rooms still get closed by someone). Affinity OFF: the
 * original fleet-wide SCAN, unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { AutoCloseService } from "@src/domains/room/auto-close/index.js";
import { AutoCloseEvaluator } from "@src/domains/room/auto-close/auto-close-evaluator.js";
import type { Redis } from "ioredis";
import type { PresenceTracker } from "@src/domains/room/presence-tracker.js";

/**
 * Redis mock: SCAN yields the fleet's room:state keys; pipelined EXISTS
 * answers per key — `room:{id}:activity` from `activity`, `cascade:room:{id}:owner`
 * from `owners`. Counters expose whether SCAN ran.
 */
function mockRedis(opts: {
  fleetRooms: string[];
  activity?: Set<string>;
  owners?: Set<string>;
}) {
  const activity = opts.activity ?? new Set<string>();
  const owners = opts.owners ?? new Set<string>();
  const scanCalls = { count: 0 };

  const redis = {
    scan: vi.fn(async () => {
      scanCalls.count++;
      return ["0", opts.fleetRooms.map((r) => `room:state:${r}`)];
    }),
    pipeline: () => {
      const keys: string[] = [];
      const p = {
        exists: (k: string) => {
          keys.push(k);
          return p;
        },
        exec: async () =>
          keys.map((k) => {
            const activityMatch = /^room:(.+):activity$/.exec(k);
            if (activityMatch) return [null, activity.has(activityMatch[1]!) ? 1 : 0];
            const ownerMatch = /^cascade:room:(.+):owner$/.exec(k);
            if (ownerMatch) return [null, owners.has(ownerMatch[1]!) ? 1 : 0];
            return [null, 0];
          }),
      };
      return p;
    },
  } as unknown as Redis;

  return { redis, scanCalls };
}

/** Presence tracker stub: every candidate reads as long-empty → closes. */
function alwaysCloseTracker() {
  return {
    reconcile: vi.fn(async () => 0),
    getZeroSince: vi.fn(() => 0),
  } as unknown as PresenceTracker;
}

function service(
  redis: Redis,
  localRooms: string[] | null,
  affinity: boolean,
) {
  return new AutoCloseService(
    redis,
    alwaysCloseTracker(),
    new AutoCloseEvaluator(),
    localRooms ? () => localRooms : null,
    () => affinity,
  );
}

describe("AutoCloseService — owned-scope sweep (aws-production/19)", () => {
  it("with affinity on, candidacy comes from local rooms — no fleet SCAN", async () => {
    const { redis, scanCalls } = mockRedis({ fleetRooms: ["foreign-1"] });
    const svc = service(redis, ["local-1", "local-2"], true);

    const inactive = await svc.getInactiveRoomIds();

    expect(inactive.sort()).toEqual(["local-1", "local-2"]);
    expect(scanCalls.count).toBe(0);
  });

  it("a local room with fresh activity is not a candidate", async () => {
    const { redis } = mockRedis({
      fleetRooms: [],
      activity: new Set(["local-1"]),
    });
    const svc = service(redis, ["local-1", "local-2"], true);

    expect(await svc.getInactiveRoomIds()).toEqual(["local-2"]);
  });

  it("the 10th sweep runs the orphan net: ownerless foreign rooms admitted, owned-elsewhere left alone", async () => {
    const { redis, scanCalls } = mockRedis({
      fleetRooms: ["orphan-1", "owned-elsewhere"],
      owners: new Set(["owned-elsewhere"]),
    });
    const svc = service(redis, ["local-1"], true);

    for (let i = 1; i <= 9; i++) {
      const inactive = await svc.getInactiveRoomIds();
      expect(inactive).toEqual(["local-1"]);
    }
    expect(scanCalls.count).toBe(0);

    const tenth = await svc.getInactiveRoomIds();

    expect(scanCalls.count).toBe(1);
    expect(tenth.sort()).toEqual(["local-1", "orphan-1"]);
    expect(tenth).not.toContain("owned-elsewhere");
  });

  it("with affinity off, the fleet SCAN path is unchanged", async () => {
    const { redis, scanCalls } = mockRedis({ fleetRooms: ["fleet-1"] });
    const svc = service(redis, ["local-1"], false);

    expect(await svc.getInactiveRoomIds()).toEqual(["fleet-1"]);
    expect(scanCalls.count).toBe(1);
  });

  it("with no local registry wired, falls back to the fleet SCAN even under affinity", async () => {
    const { redis, scanCalls } = mockRedis({ fleetRooms: ["fleet-1"] });
    const svc = service(redis, null, true);

    expect(await svc.getInactiveRoomIds()).toEqual(["fleet-1"]);
    expect(scanCalls.count).toBe(1);
  });
});
