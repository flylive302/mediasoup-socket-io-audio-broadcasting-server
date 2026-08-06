import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  eventVersionMs,
  acceptIfNotOlder,
  writeIfNewer,
  ROOM_UPDATED_VERSION_KEY,
  ROOM_BLOCK_VERSION_KEY,
  VERSION_TTL_SECONDS,
} from "@src/infrastructure/event-ordering.js";

function createMockRedis() {
  return {
    eval: vi.fn().mockResolvedValue(1),
  } as any;
}

describe("eventVersionMs", () => {
  it("returns null for undefined", () => {
    expect(eventVersionMs(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(eventVersionMs("")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(eventVersionMs("not-a-date")).toBeNull();
  });

  it("returns the correct epoch ms for a valid ISO 8601 string", () => {
    const iso = "2026-08-06T12:00:00.000Z";

    expect(eventVersionMs(iso)).toBe(Date.parse(iso));
  });
});

describe("acceptIfNotOlder", () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
  });

  it("returns true when redis.eval resolves 1", async () => {
    redis.eval.mockResolvedValue(1);

    const result = await acceptIfNotOlder(redis, "version-key", 1_000);

    expect(result).toBe(true);
  });

  it("returns false when redis.eval resolves 0", async () => {
    redis.eval.mockResolvedValue(0);

    const result = await acceptIfNotOlder(redis, "version-key", 1_000);

    expect(result).toBe(false);
  });

  it("FAILS OPEN — returns true when eval rejects", async () => {
    redis.eval.mockRejectedValue(new Error("redis down"));

    const result = await acceptIfNotOlder(redis, "version-key", 1_000);

    expect(result).toBe(true);
  });

  it("calls eval with numKeys 1, the key, and version + ttl as strings, ttl defaulting to VERSION_TTL_SECONDS", async () => {
    redis.eval.mockResolvedValue(1);

    await acceptIfNotOlder(redis, "some-version-key", 1_730_000_000_000);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "some-version-key",
      "1730000000000",
      String(VERSION_TTL_SECONDS),
    );
  });
});

describe("writeIfNewer", () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
  });

  it("returns true on 1", async () => {
    redis.eval.mockResolvedValue(1);

    expect(await writeIfNewer(redis, "key", 1_730_000_000_000, 600)).toBe(true);
  });

  it("returns false on 0", async () => {
    redis.eval.mockResolvedValue(0);

    expect(await writeIfNewer(redis, "key", 1_730_000_000_000, 600)).toBe(false);
  });

  it("FAILS OPEN — returns true on rejection", async () => {
    redis.eval.mockRejectedValue(new Error("redis down"));

    expect(await writeIfNewer(redis, "key", 1_730_000_000_000, 600)).toBe(true);
  });

  it("passes value and ttl through to eval as strings", async () => {
    redis.eval.mockResolvedValue(1);

    await writeIfNewer(redis, "revoke-key", 1_730_000_000_000, 900);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "revoke-key",
      "1730000000000",
      "900",
    );
  });
});

describe("version key builders", () => {
  it("ROOM_UPDATED_VERSION_KEY and ROOM_BLOCK_VERSION_KEY each start with 'msab:ver:'", () => {
    expect(ROOM_UPDATED_VERSION_KEY("42")).toMatch(/^msab:ver:/);
    expect(ROOM_BLOCK_VERSION_KEY("42", 7)).toMatch(/^msab:ver:/);
  });

  it("ROOM_BLOCK_VERSION_KEY returns the SAME key for a given (room,user) pair regardless of which caller builds it — block and unblock share one marker", () => {
    const fromBlockCaller = ROOM_BLOCK_VERSION_KEY("42", 7);
    const fromUnblockCaller = ROOM_BLOCK_VERSION_KEY("42", 7);

    expect(fromBlockCaller).toBe(fromUnblockCaller);
    expect(ROOM_BLOCK_VERSION_KEY("42", 8)).not.toBe(fromBlockCaller);
    expect(ROOM_BLOCK_VERSION_KEY("43", 7)).not.toBe(fromBlockCaller);
  });
});

describe("VERSION_TTL_SECONDS", () => {
  it("is a positive finite number", () => {
    expect(Number.isFinite(VERSION_TTL_SECONDS)).toBe(true);
    expect(VERSION_TTL_SECONDS).toBeGreaterThan(0);
  });
});
