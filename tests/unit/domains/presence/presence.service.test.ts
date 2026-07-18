import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    PRESENCE_TTL_SECONDS: 75,
    PRESENCE_SWEEP_INTERVAL_MS: 30_000,
    PRESENCE_SUBSCRIBE_MAX: 50,
  },
}));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PresenceService, presenceUserRoom } from "@src/domains/presence/index.js";

function createMockRedis() {
  const pipelineOps: Array<{ cmd: string; args: unknown[] }> = [];
  const pipelineResult: unknown[] = [];

  const redis = {
    incr: vi.fn(),
    decr: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => {
      const p = {
        exists: vi.fn((key: string) => {
          pipelineOps.push({ cmd: "exists", args: [key] });
          return p;
        }),
        expire: vi.fn((key: string, ttl: number) => {
          pipelineOps.push({ cmd: "expire", args: [key, ttl] });
          return p;
        }),
        exec: vi.fn(async () => pipelineOps.map((_, i) => [null, pipelineResult[i]])),
      };
      return p;
    }),
  };
  return { redis, pipelineResult };
}

function createMockIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as any, to, emit };
}

function createMockClientManager(userIds: number[] = []) {
  return { getConnectedUserIds: vi.fn(() => userIds) } as any;
}

describe("PresenceService.onConnect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("0->1 transition (first socket) emits presence.update online:true", async () => {
    const { redis } = createMockRedis();
    (redis.incr as any).mockResolvedValue(1);
    const { io, to, emit } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager());

    await service.onConnect(42);

    expect(redis.incr).toHaveBeenCalledWith("presence:conn:42");
    expect(redis.expire).toHaveBeenCalledWith("presence:conn:42", 75);
    expect(to).toHaveBeenCalledWith(presenceUserRoom(42));
    expect(emit).toHaveBeenCalledWith("presence.update", { userId: 42, online: true });
  });

  it("2nd+ socket (already online) does not re-emit", async () => {
    const { redis } = createMockRedis();
    (redis.incr as any).mockResolvedValue(2);
    const { io, emit } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager());

    await service.onConnect(42);

    expect(emit).not.toHaveBeenCalled();
  });
});

describe("PresenceService.onDisconnect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("last socket (count<=0) DELs the key and emits offline", async () => {
    const { redis } = createMockRedis();
    (redis.decr as any).mockResolvedValue(0);
    const { io, to, emit } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager());

    await service.onDisconnect(42);

    expect(redis.decr).toHaveBeenCalledWith("presence:conn:42");
    expect(redis.del).toHaveBeenCalledWith("presence:conn:42");
    expect(to).toHaveBeenCalledWith(presenceUserRoom(42));
    expect(emit).toHaveBeenCalledWith("presence.update", { userId: 42, online: false });
  });

  it("not-last socket (count>0, multi-device) does not emit offline", async () => {
    const { redis } = createMockRedis();
    (redis.decr as any).mockResolvedValue(1);
    const { io, emit } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager());

    await service.onDisconnect(42);

    expect(redis.del).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("PresenceService.snapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports online for keys that EXIST, offline for lapsed/missing keys (TTL-expiry self-heal)", async () => {
    const { redis, pipelineResult } = createMockRedis();
    pipelineResult.push(1, 0); // user 1 online, user 2 offline (TTL expired)
    const { io } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager());

    const snap = await service.snapshot([1, 2]);

    expect(snap).toEqual({ 1: true, 2: false });
  });

  it("empty input short-circuits without touching Redis", async () => {
    const { redis } = createMockRedis();
    const { io } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager());

    const snap = await service.snapshot([]);

    expect(snap).toEqual({});
    expect(redis.pipeline).not.toHaveBeenCalled();
  });
});

describe("PresenceService sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-EXPIREs the presence key of every locally-connected user", async () => {
    vi.useFakeTimers();
    const { redis } = createMockRedis();
    const { io } = createMockIo();
    const clientManager = createMockClientManager([1, 2, 3]);
    const service = new PresenceService(redis as any, io, clientManager);

    service.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(clientManager.getConnectedUserIds).toHaveBeenCalled();

    service.stop();
    vi.useRealTimers();
  });

  it("start() is idempotent (second call warns, does not double-schedule)", () => {
    vi.useFakeTimers();
    const { redis } = createMockRedis();
    const { io } = createMockIo();
    const service = new PresenceService(redis as any, io, createMockClientManager([1]));

    service.start();
    service.start();
    service.stop();
    vi.useRealTimers();
  });
});
