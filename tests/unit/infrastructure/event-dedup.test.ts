import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: { INSTANCE_ID: "i-test-aaa" },
  isDev: false,
}));

import {
  buildDedupKey,
  claimEvent,
  releaseClaim,
  DEDUP_TTL_SECONDS,
} from "@src/infrastructure/event-dedup.js";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";

function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  } as any;
}

function makeEvent(overrides: Partial<LaravelEvent> = {}): LaravelEvent {
  return {
    event: "balance.updated",
    user_id: null,
    room_id: null,
    payload: {},
    correlation_id: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("buildDedupKey", () => {
  it("returns null when correlation_id is the zod-default literal 'unknown'", () => {
    expect(buildDedupKey(makeEvent({ correlation_id: "unknown" }))).toBeNull();
  });

  it("returns null when correlation_id is an empty string", () => {
    expect(buildDedupKey(makeEvent({ correlation_id: "" }))).toBeNull();
  });

  it("returns a string containing the mocked instance id when correlation_id is real", () => {
    const key = buildDedupKey(makeEvent({ correlation_id: "real-correlation-id" }));
    expect(key).toContain("i-test-aaa");
  });

  it("CRITICAL — the two 'room.member_removed' copies emitted by ONE kick request (same correlation_id, same payload, only user_id/room_id differ) get DIFFERENT dedup keys. Collapsing them would stop blocked users being ejected from their seats.", () => {
    const correlationId = "22222222-2222-2222-2222-222222222222";
    const payload = { reason: "blocked" };

    // backend/app/Services/Realtime/Emitters/RoomEventEmitter.php:116-117
    //   $this->emit('room.member_removed', $payload, $userId);        // user_id set, room_id NULL
    //   $this->emit('room.member_removed', $payload, null, $roomId);  // user_id NULL, room_id set
    const userCopy = makeEvent({
      event: "room.member_removed",
      correlation_id: correlationId,
      user_id: 501,
      room_id: null,
      payload,
    });
    const roomCopy = makeEvent({
      event: "room.member_removed",
      correlation_id: correlationId,
      user_id: null,
      room_id: 42,
      payload,
    });

    const userKey = buildDedupKey(userCopy);
    const roomKey = buildDedupKey(roomCopy);

    expect(userKey).not.toBeNull();
    expect(roomKey).not.toBeNull();
    expect(userKey).not.toBe(roomKey);
  });

  it("produces the SAME key for two envelopes identical in every field (a true redelivery)", () => {
    const a = makeEvent({
      correlation_id: "c-identical",
      event: "balance.updated",
      user_id: 7,
      room_id: null,
      payload: { amount: 5 },
    });
    const b = makeEvent({
      correlation_id: "c-identical",
      event: "balance.updated",
      user_id: 7,
      room_id: null,
      payload: { amount: 5 },
    });

    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("produces a different key when payload differs", () => {
    const a = makeEvent({ correlation_id: "c-payload-diff", payload: { amount: 5 } });
    const b = makeEvent({ correlation_id: "c-payload-diff", payload: { amount: 6 } });

    expect(buildDedupKey(a)).not.toBe(buildDedupKey(b));
  });

  it("canonicalizes payload key order — {a,b} and {b,a} hash equal", () => {
    const a = makeEvent({ correlation_id: "c-order", payload: { a: 1, b: 2 } });
    const b = makeEvent({ correlation_id: "c-order", payload: { b: 2, a: 1 } });

    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("canonicalizes nested payload key order too", () => {
    const a = makeEvent({ correlation_id: "c-nested-order", payload: { outer: { a: 1, b: 2 } } });
    const b = makeEvent({ correlation_id: "c-nested-order", payload: { outer: { b: 2, a: 1 } } });

    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("excludes timestamp from the key — envelopes differing ONLY in timestamp still collide", () => {
    const a = makeEvent({ correlation_id: "c-timestamp", timestamp: "2026-01-01T00:00:00.000Z" });
    const b = makeEvent({ correlation_id: "c-timestamp", timestamp: "2026-06-01T00:00:00.000Z" });

    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("treats array order as significant — [1,2] vs [2,1] produce different keys", () => {
    const a = makeEvent({ correlation_id: "c-array-order", payload: { list: [1, 2] } });
    const b = makeEvent({ correlation_id: "c-array-order", payload: { list: [2, 1] } });

    expect(buildDedupKey(a)).not.toBe(buildDedupKey(b));
  });
});

describe("claimEvent", () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
  });

  it("returns true when redis.set resolves 'OK', using the ioredis variadic NX form", async () => {
    redis.set.mockResolvedValue("OK");

    const result = await claimEvent(redis, "some-key");

    expect(result).toBe(true);
    expect(redis.set).toHaveBeenCalledWith("some-key", "1", "EX", DEDUP_TTL_SECONDS, "NX");
  });

  it("returns false when set resolves null (key already existed)", async () => {
    redis.set.mockResolvedValue(null);

    const result = await claimEvent(redis, "some-key");

    expect(result).toBe(false);
  });

  it("FAILS OPEN — returns true when set rejects", async () => {
    redis.set.mockRejectedValue(new Error("redis down"));

    const result = await claimEvent(redis, "some-key");

    expect(result).toBe(true);
  });

  it("passes a custom ttl argument through to set", async () => {
    redis.set.mockResolvedValue("OK");

    await claimEvent(redis, "some-key", 120);

    expect(redis.set).toHaveBeenCalledWith("some-key", "1", "EX", 120, "NX");
  });
});

describe("releaseClaim", () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
  });

  it("calls del with the key", async () => {
    await releaseClaim(redis, "some-key");

    expect(redis.del).toHaveBeenCalledWith("some-key");
  });

  it("swallows a rejecting del (does not throw)", async () => {
    redis.del.mockRejectedValue(new Error("redis down"));

    await expect(releaseClaim(redis, "some-key")).resolves.toBeUndefined();
  });
});

describe("DEDUP_TTL_SECONDS", () => {
  it("is a positive finite number (the gate requires a bounded TTL)", () => {
    expect(Number.isFinite(DEDUP_TTL_SECONDS)).toBe(true);
    expect(DEDUP_TTL_SECONDS).toBeGreaterThan(0);
  });
});
