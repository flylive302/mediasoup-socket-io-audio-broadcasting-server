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

  describe("cleanup", () => {
    it("removes origin + owner keys for a room", async () => {
      await registry.registerOrigin("room-1", originInfo);

      await registry.cleanup("room-1");

      expect(await registry.getOrigin("room-1")).toBeNull();
      expect(await registry.getEdges("room-1")).toHaveLength(0);
    });
  });
});
