/**
 * aws-production/23 — the ownership lease survives a >90s owner stall.
 *
 * Incident B1: the 90s CAS TTL expires during an owner pause (GC / Redis blip /
 * CPU saturation). Before this ticket, the refresh Lua was a pure no-op once
 * the key expired — the stalled owner NEVER re-established its claim, kept its
 * local cluster, and a rival's join-time SETNX created a second origin. The
 * loss was silent to the holder.
 *
 * The fix makes refreshOwnership report what actually happened:
 *   "held"      — claim still ours, TTL extended (the steady state)
 *   "reclaimed" — key had expired but NOBODY took it; we atomically re-claim.
 *                 This is the common stall outcome (rivals only claim when a
 *                 client lands on them) and turns B1's silent decay into a
 *                 logged, metered self-heal.
 *   "lost"      — a rival holds the claim; the caller must STEP DOWN, never
 *                 write as origin again for this room.
 *
 * The reclaim branch is opt-in (allowReclaim) so cascade EDGE instances — which
 * heartbeat rooms they hold but do not own — can never steal an origin's
 * expired claim.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoomRegistry } from "@src/domains/room/room-registry.js";

/**
 * Redis mock implementing the REAL semantics the refresh Lua needs: GET-compare,
 * EXPIRE-if-held, and SET-if-absent-when-reclaim-allowed. Interpreted from the
 * eval args (not the script text), mirroring room-registry.contention.test.ts.
 */
function createStallMockRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  return {
    set: vi.fn(
      async (
        key: string,
        value: string,
        _ex: string,
        ttl: number,
        nx?: string,
      ) => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        ttls.set(key, ttl);
        return "OK";
      },
    ),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) {
        store.delete(k);
        ttls.delete(k);
      }
    }),
    // New refresh Lua semantics: 1 = held (EXPIRE), 2 = reclaimed (SET on nil
    // when ARGV[3] === "1"), 0 = lost to a live rival claim.
    eval: vi.fn(
      async (
        _script: string,
        _numKeys: number,
        key: string,
        instanceId: string,
        ttl: string,
        allowReclaim?: string,
      ) => {
        const cur = store.get(key);
        if (cur === instanceId) {
          ttls.set(key, Number(ttl));
          return 1;
        }
        if (cur === undefined && allowReclaim === "1") {
          store.set(key, instanceId);
          ttls.set(key, Number(ttl));
          return 2;
        }
        return 0;
      },
    ),
    setex: vi.fn(async () => {}),
    hset: vi.fn(async () => {}),
    hdel: vi.fn(async () => {}),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    expire: vi.fn(async () => {}),
    _store: store,
    _ttls: ttls,
    /** Simulates the B1 stall: the owner's TTL lapses while it is paused. */
    _expireKey(key: string) {
      store.delete(key);
      ttls.delete(key);
    },
  };
}

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const ROOM = "room-stalled";
const OWNER_KEY = `cascade:room:${ROOM}:owner`;

describe("RoomRegistry — a >90s owner stall cannot silently transfer ownership (aws-production/23)", () => {
  let redis: ReturnType<typeof createStallMockRedis>;
  let registry: RoomRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createStallMockRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry = new RoomRegistry(redis as any, mockLogger);
  });

  it("steady state: refresh reports 'held' and extends the TTL", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._ttls.set(OWNER_KEY, 10);

    const result = await registry.refreshOwnership(ROOM, "instance-A", {
      allowReclaim: true,
    });

    expect(result).toBe("held");
    expect(redis._ttls.get(OWNER_KEY)).toBe(90);
  });

  it("stall with no rival: the owner atomically RECLAIMS its expired claim", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._expireKey(OWNER_KEY); // >90s pause — TTL lapsed, nobody claimed

    const result = await registry.refreshOwnership(ROOM, "instance-A", {
      allowReclaim: true,
    });

    expect(result).toBe("reclaimed");
    expect(redis._store.get(OWNER_KEY)).toBe("instance-A");
    expect(redis._ttls.get(OWNER_KEY)).toBe(90);
  });

  it("after a reclaim, isOwner immediately reads true (no stale-cache false)", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    // Prime the owner cache with the pre-stall read.
    expect(await registry.isOwner(ROOM, "instance-A")).toBe(true);
    redis._expireKey(OWNER_KEY);

    await registry.refreshOwnership(ROOM, "instance-A", { allowReclaim: true });

    expect(await registry.isOwner(ROOM, "instance-A")).toBe(true);
  });

  it("stall with a rival claim: refresh reports 'lost' and NEVER resurrects the key", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._expireKey(OWNER_KEY);
    await registry.claimOwnership(ROOM, "instance-B"); // rival won while A was paused

    const result = await registry.refreshOwnership(ROOM, "instance-A", {
      allowReclaim: true,
    });

    expect(result).toBe("lost");
    expect(redis._store.get(OWNER_KEY)).toBe("instance-B");
  });

  it("without allowReclaim (edge / join path), an expired claim is 'lost', not stolen", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._expireKey(OWNER_KEY);

    const result = await registry.refreshOwnership(ROOM, "instance-B");

    expect(result).toBe("lost");
    expect(redis._store.has(OWNER_KEY)).toBe(false);
  });

  it("two stalled ex-owners racing to reclaim: exactly one wins, the other learns 'lost'", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._expireKey(OWNER_KEY);

    // Redis serializes evals — model the race as sequential atomic scripts.
    const first = await registry.refreshOwnership(ROOM, "instance-A", {
      allowReclaim: true,
    });
    const second = await registry.refreshOwnership(ROOM, "instance-B", {
      allowReclaim: true,
    });

    expect(first).toBe("reclaimed");
    expect(second).toBe("lost");
    expect(redis._store.get(OWNER_KEY)).toBe("instance-A");
  });
});
