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

  const edgeInfo1: InstanceInfo = {
    instanceId: "i-edge-001",
    ip: "10.0.2.1",
    port: 40100,
    listenerCount: 0,
  };

  const edgeInfo2: InstanceInfo = {
    instanceId: "i-edge-002",
    ip: "10.0.3.1",
    port: 40200,
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

  describe("edge registration", () => {
    it("registerEdge → getEdges returns correct entries", async () => {
      await registry.registerEdge("room-1", edgeInfo1);
      await registry.registerEdge("room-1", edgeInfo2);

      const edges = await registry.getEdges("room-1");
      expect(edges).toHaveLength(2);
      expect(edges).toContainEqual(edgeInfo1);
      expect(edges).toContainEqual(edgeInfo2);
    });

    it("removeEdge removes only the specified edge", async () => {
      await registry.registerEdge("room-1", edgeInfo1);
      await registry.registerEdge("room-1", edgeInfo2);

      await registry.removeEdge("room-1", edgeInfo1.instanceId);

      const edges = await registry.getEdges("room-1");
      expect(edges).toHaveLength(1);
      expect(edges[0]).toEqual(edgeInfo2);
    });

    it("getEdges returns empty for room with no edges", async () => {
      const edges = await registry.getEdges("room-no-edges");
      expect(edges).toHaveLength(0);
    });
  });

  describe("listener counts", () => {
    it("updateListenerCount adjusts origin count", async () => {
      await registry.registerOrigin("room-1", originInfo);

      const count = await registry.updateListenerCount("room-1", originInfo.instanceId, 5);
      expect(count).toBe(5);

      const updated = await registry.getOrigin("room-1");
      expect(updated!.listenerCount).toBe(5);
    });

    it("updateListenerCount adjusts edge count", async () => {
      await registry.registerOrigin("room-1", originInfo);
      await registry.registerEdge("room-1", edgeInfo1);

      const count = await registry.updateListenerCount("room-1", edgeInfo1.instanceId, 10);
      expect(count).toBe(10);
    });

    it("updateListenerCount does not go below zero", async () => {
      await registry.registerOrigin("room-1", originInfo);
      const count = await registry.updateListenerCount("room-1", originInfo.instanceId, -5);
      expect(count).toBe(0);
    });

    it("updateListenerCount returns 0 for unknown instance", async () => {
      await registry.registerOrigin("room-1", originInfo);
      const count = await registry.updateListenerCount("room-1", "i-unknown", 1);
      expect(count).toBe(0);
    });

    it("getTotalListeners sums origin + all edges", async () => {
      await registry.registerOrigin("room-1", { ...originInfo, listenerCount: 100 });
      await registry.registerEdge("room-1", { ...edgeInfo1, listenerCount: 200 });
      await registry.registerEdge("room-1", { ...edgeInfo2, listenerCount: 300 });

      const total = await registry.getTotalListeners("room-1");
      expect(total).toBe(600);
    });

    it("getTotalListeners returns 0 for unregistered room", async () => {
      const total = await registry.getTotalListeners("nonexistent");
      expect(total).toBe(0);
    });
  });

  describe("findBestInstance", () => {
    it("returns the least-loaded instance", async () => {
      await registry.registerOrigin("room-1", { ...originInfo, listenerCount: 500 });
      await registry.registerEdge("room-1", { ...edgeInfo1, listenerCount: 100 });
      await registry.registerEdge("room-1", { ...edgeInfo2, listenerCount: 300 });

      const best = await registry.findBestInstance("room-1");
      expect(best.instanceId).toBe(edgeInfo1.instanceId);
      expect(best.listenerCount).toBe(100);
    });

    it("throws for room with no instances", async () => {
      await expect(registry.findBestInstance("nonexistent")).rejects.toThrow(
        "No instances found",
      );
    });
  });

  describe("cleanup", () => {
    it("removes all keys for a room", async () => {
      await registry.registerOrigin("room-1", originInfo);
      await registry.registerEdge("room-1", edgeInfo1);

      await registry.cleanup("room-1");

      expect(await registry.getOrigin("room-1")).toBeNull();
      expect(await registry.getEdges("room-1")).toHaveLength(0);
    });
  });
});
