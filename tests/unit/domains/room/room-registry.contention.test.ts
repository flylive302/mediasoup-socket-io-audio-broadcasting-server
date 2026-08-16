/**
 * aws-production/19 — ownership guarantees re-verified under contention.
 *
 * Two instances must never both act as owner: the CAS claim is SET NX (one
 * winner), and the refresh Lua only extends a claim the caller still holds —
 * an instance whose claim expired and was reclaimed by another cannot
 * resurrect it. These are the guarantees affinity's room-local presence and
 * sweeps stand on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoomRegistry } from "@src/domains/room/room-registry.js";

/** Minimal Redis mock with real SET-NX + compare-and-expire Lua semantics. */
function createCasMockRedis() {
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
    // Emulates the refresh Lua: EXPIRE only when GET(key) === instanceId.
    eval: vi.fn(
      async (
        _script: string,
        _numKeys: number,
        key: string,
        instanceId: string,
        ttl: string,
      ) => {
        if (store.get(key) === instanceId) {
          ttls.set(key, Number(ttl));
          return 1;
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

const ROOM = "room-contested";
const OWNER_KEY = `cascade:room:${ROOM}:owner`;

describe("RoomRegistry — ownership under contention (aws-production/19)", () => {
  let redis: ReturnType<typeof createCasMockRedis>;
  let registry: RoomRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createCasMockRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry = new RoomRegistry(redis as any, mockLogger);
  });

  it("only one of two concurrent claims wins, and the loser learns the winner", async () => {
    const a = await registry.claimOwnership(ROOM, "instance-A");
    const b = await registry.claimOwnership(ROOM, "instance-B");

    expect(a).toEqual({ won: true, owner: "instance-A" });
    expect(b).toEqual({ won: false, owner: "instance-A" });
    expect(redis._store.get(OWNER_KEY)).toBe("instance-A");
  });

  it("refresh extends only the holder's claim", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._ttls.set(OWNER_KEY, 10);

    await registry.refreshOwnership(ROOM, "instance-A");

    expect(redis._ttls.get(OWNER_KEY)).toBe(90);
    expect(redis._store.get(OWNER_KEY)).toBe("instance-A");
  });

  it("a stale ex-owner cannot resurrect a claim another instance reclaimed", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._expireKey(OWNER_KEY); // A's TTL lapses (crash / stall > 90s)
    await registry.claimOwnership(ROOM, "instance-B");

    await registry.refreshOwnership(ROOM, "instance-A"); // A comes back

    expect(redis._store.get(OWNER_KEY)).toBe("instance-B");
    expect(redis._ttls.get(OWNER_KEY)).toBe(90);
  });

  it("after losing the claim, the stale ex-owner reads isOwner=false (never acts as owner)", async () => {
    await registry.claimOwnership(ROOM, "instance-A");
    redis._expireKey(OWNER_KEY);
    await registry.claimOwnership(ROOM, "instance-B");

    expect(await registry.isOwner(ROOM, "instance-A")).toBe(false);
    expect(await registry.isOwner(ROOM, "instance-B")).toBe(true);
  });
});
