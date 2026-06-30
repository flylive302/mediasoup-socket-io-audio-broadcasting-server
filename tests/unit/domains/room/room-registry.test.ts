import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoomRegistry, type InstanceInfo } from "@src/domains/room/room-registry.js";

// ─── Mock Redis ─────────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, string>();
  const hashStore = new Map<string, Map<string, string>>();

  return {
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) {
        store.delete(k);
        hashStore.delete(k);
      }
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashStore.has(key)) hashStore.set(key, new Map());
      hashStore.get(key)!.set(field, value);
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      hashStore.get(key)?.delete(field);
    }),
    hget: vi.fn(async (key: string, field: string) => {
      return hashStore.get(key)?.get(field) ?? null;
    }),
    hgetall: vi.fn(async (key: string) => {
      const map = hashStore.get(key);
      if (!map) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of map) result[k] = v;
      return result;
    }),
    expire: vi.fn(async () => {}),
    // Simulate redis.eval() for the Lua script used in updateListenerCount
    eval: vi.fn(async (_script: string, _numKeys: number, originKey: string, edgesKey: string, instanceId: string, deltaStr: string) => {
      const delta = Number(deltaStr);

      // Try origin first
      const originData = store.get(originKey);
      if (originData) {
        const origin = JSON.parse(originData);
        if (origin.instanceId === instanceId) {
          origin.listenerCount = Math.max(0, origin.listenerCount + delta);
          store.set(originKey, JSON.stringify(origin));
          return origin.listenerCount;
        }
      }

      // Try edge hash
      const edgeMap = hashStore.get(edgesKey);
      if (edgeMap) {
        const edgeData = edgeMap.get(instanceId);
        if (edgeData) {
          const edge = JSON.parse(edgeData);
          edge.listenerCount = Math.max(0, edge.listenerCount + delta);
          edgeMap.set(instanceId, JSON.stringify(edge));
          return edge.listenerCount;
        }
      }

      return -1;
    }),
    // Expose internals for assertions
    _store: store,
    _hashStore: hashStore,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ─── Tests ──────────────────────────────────────────────────────────

describe("RoomRegistry", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let registry: RoomRegistry;

  const originInfo: InstanceInfo = {
    instanceId: "i-origin-001",
    ip: "10.0.1.1",
    port: 40000,
    listenerCount: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry = new RoomRegistry(redis as any, mockLogger);
  });

  describe("origin registration", () => {
    it("registerOrigin → getOrigin round-trip", async () => {
      await registry.registerOrigin("room-1", originInfo);
      const result = await registry.getOrigin("room-1");
      expect(result).toEqual(originInfo);
    });

    it("getOrigin returns null for unregistered room", async () => {
      const result = await registry.getOrigin("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("origin listenerCount preservation (F-32)", () => {
    it("re-registering origin does NOT clobber an existing listenerCount", async () => {
      // First register seeds count 0; simulate a later non-zero count, then a
      // re-register (every join calls registerOrigin) must preserve it.
      await registry.registerOrigin("room-1", originInfo);
      redis._store.set(
        "cascade:room:room-1:origin",
        JSON.stringify({ ...originInfo, listenerCount: 42 }),
      );

      await registry.registerOrigin("room-1", { ...originInfo, listenerCount: 0 });

      const result = await registry.getOrigin("room-1");
      expect(result!.listenerCount).toBe(42);
    });

    it("first registration uses the provided listenerCount", async () => {
      await registry.registerOrigin("room-1", { ...originInfo, listenerCount: 7 });
      const result = await registry.getOrigin("room-1");
      expect(result!.listenerCount).toBe(7);
    });
  });

  describe("isOwner (realtime-17)", () => {
    const ownerKey = "cascade:room:room-1:owner";

    it("true when the CAS owner key matches this instance", async () => {
      redis._store.set(ownerKey, "i-self");
      expect(await registry.isOwner("room-1", "i-self")).toBe(true);
    });

    it("false when another instance holds the claim", async () => {
      redis._store.set(ownerKey, "i-other");
      expect(await registry.isOwner("room-1", "i-self")).toBe(false);
    });

    it("false when there is no owner (claim expired/unset)", async () => {
      expect(await registry.isOwner("room-1", "i-self")).toBe(false);
    });

    it("caches the read — repeated checks within the window hit Redis once", async () => {
      redis._store.set(ownerKey, "i-self");
      await registry.isOwner("room-1", "i-self");
      await registry.isOwner("room-1", "i-self");
      expect(redis.get).toHaveBeenCalledTimes(1);
    });

    it("forgetOwnerCache drops the cache-only entry without a CAS DEL", async () => {
      redis._store.set(ownerKey, "i-self");
      expect(await registry.isOwner("room-1", "i-self")).toBe(true);

      registry.forgetOwnerCache("room-1");
      // No DEL of the owner key (that belongs to the real origin on evict paths).
      expect(redis.del).not.toHaveBeenCalled();
      // The owner key is still present, so the re-read still reports ownership.
      redis.get.mockClear();
      expect(await registry.isOwner("room-1", "i-self")).toBe(true);
      expect(redis.get).toHaveBeenCalledTimes(1);
    });

    it("cleanup invalidates the cache so a re-opened room re-reads ownership", async () => {
      redis._store.set(ownerKey, "i-self");
      expect(await registry.isOwner("room-1", "i-self")).toBe(true);

      // Room closes (owner key gone) and is cleaned up — the stale cached "owner"
      // must not survive into a fresh check.
      await registry.cleanup("room-1");
      redis.get.mockClear();

      expect(await registry.isOwner("room-1", "i-self")).toBe(false);
      expect(redis.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanup", () => {
    it("removes origin + owner keys for a room", async () => {
      await registry.registerOrigin("room-1", originInfo);

      await registry.cleanup("room-1");

      expect(await registry.getOrigin("room-1")).toBeNull();
      expect(await registry.getEdges("room-1")).toHaveLength(0);
    });
  });
});
