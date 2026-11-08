/**
 * room-video-player/02 — the video slot's Lua scripts against a REAL Redis.
 *
 * The handler unit tests mock `redis.eval`, so they never run a line of Lua.
 * This file is the seam that proves: acquire writes mutex + Snapshot together,
 * revision is strictly monotonic across every write (including a re-play that
 * changes the link), the heartbeat refreshes BOTH TTLs, non-holders change
 * nothing, and cjson round-trips the Snapshot without losing precision.
 *
 * Address: MSAB_TEST_REDIS_URL, else REDIS_HOST/REDIS_PORT db 15 (same as
 * ledger.redis.test.ts). Skipped LOUDLY when no Redis answers. Each test uses
 * its own room id and deletes only its own keys; the db is never flushed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  acquireVideoSlotOnce,
  updateVideoState,
  releaseVideoSlot,
  getVideoPlayerState,
  videoPlayerKey,
  videoStateKey,
  VIDEO_PLAYER_TTL_SECONDS,
  type VideoSnapshot,
} from "@src/domains/video-player/video-player.redis.js";

const url =
  process.env.MSAB_TEST_REDIS_URL ??
  `redis://${process.env.REDIS_HOST ?? "127.0.0.1"}:${process.env.REDIS_PORT ?? "6379"}/15`;

let redis: Redis | null = null;
let available = false;

beforeAll(async () => {
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 });
  try {
    await probe.connect();
    await probe.ping();
    redis = probe;
    available = true;
  } catch {
    probe.disconnect();
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠️  video-state.redis.test.ts SKIPPED — no Redis at ${url}. ` +
        `Set MSAB_TEST_REDIS_URL to run the video Lua suite.\n`,
    );
  }
});

afterAll(async () => {
  await redis?.quit();
});

let roomCounter = 0;
const usedRooms: string[] = [];
function freshRoom(): string {
  const id = `test-video-${Date.now()}-${++roomCounter}`;
  usedRooms.push(id);
  return id;
}

afterEach(async () => {
  if (!redis) return;
  const keys = usedRooms.flatMap((r) => [videoPlayerKey(r), videoStateKey(r)]);
  if (keys.length) await redis.del(...keys);
  usedRooms.length = 0;
});

const SERVER_TS = 1_731_068_400_123; // 13 digits — must survive cjson exactly

function draft(userId: number, overrides: Partial<VideoSnapshot> = {}): Omit<VideoSnapshot, "revision"> {
  return {
    controllerUserId: userId,
    source: { kind: "youtube", videoId: "dQw4w9WgXcQ" },
    paused: false,
    positionAtTs: 0,
    serverTs: SERVER_TS,
    ...overrides,
  };
}

describe("video slot Lua (real Redis)", () => {
  it("acquire writes mutex + Snapshot together with revision 1 and the full TTL", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();

    const res = await acquireVideoSlotOnce(redis, room, 10, "", draft(10, { title: "Ünïcode \"quoted\" / title" }));

    expect(res.acquired).toBe(true);
    if (!res.acquired) return;
    expect(res.snapshot).toEqual({ ...draft(10, { title: "Ünïcode \"quoted\" / title" }), revision: 1 });
    expect(await redis.get(videoPlayerKey(room))).toBe("10");
    expect(await getVideoPlayerState(redis, room)).toEqual(res.snapshot);
    expect(await redis.ttl(videoPlayerKey(room))).toBeGreaterThan(VIDEO_PLAYER_TTL_SECONDS - 5);
    expect(await redis.ttl(videoStateKey(room))).toBeGreaterThan(VIDEO_PLAYER_TTL_SECONDS - 5);
  });

  it("a live different holder denies and nothing changes", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await acquireVideoSlotOnce(redis, room, 10, "", draft(10));

    const res = await acquireVideoSlotOnce(redis, room, 20, "", draft(20));

    expect(res).toEqual({ acquired: false, holder: "10" });
    expect((await getVideoPlayerState(redis, room))?.controllerUserId).toBe(10);
  });

  it("steal is a CAS: succeeds against the named holder, loses once a rival has taken it", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await acquireVideoSlotOnce(redis, room, 10, "", draft(10));

    const first = await acquireVideoSlotOnce(redis, room, 20, "10", draft(20));
    const second = await acquireVideoSlotOnce(redis, room, 30, "10", draft(30));

    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, holder: "20" });
  });

  it("revision never decreases across play → pause → seek → heartbeat → re-play (link change)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    const seen: number[] = [];

    const play = await acquireVideoSlotOnce(redis, room, 10, "", draft(10));
    if (play.acquired) seen.push(play.snapshot.revision);
    seen.push((await updateVideoState(redis, room, 10, 12.25, SERVER_TS + 1, "pause"))!.revision);
    seen.push((await updateVideoState(redis, room, 10, 30, SERVER_TS + 2, "keep"))!.revision);
    seen.push((await updateVideoState(redis, room, 10, 31, SERVER_TS + 3, "play"))!.revision);
    const replay = await acquireVideoSlotOnce(
      redis,
      room,
      10,
      "",
      draft(10, { source: { kind: "url", url: "https://cdn.example.com/b.mp4", container: "mp4" } }),
    );
    if (replay.acquired) seen.push(replay.snapshot.revision);

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("after a release the next session starts again at revision 1", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await acquireVideoSlotOnce(redis, room, 10, "", draft(10));
    await updateVideoState(redis, room, 10, 5, SERVER_TS, "pause");

    expect(await releaseVideoSlot(redis, room, 10)).toBe(true);
    expect(await redis.exists(videoPlayerKey(room), videoStateKey(room))).toBe(0);

    const next = await acquireVideoSlotOnce(redis, room, 20, "", draft(20));
    expect(next.acquired && next.snapshot.revision).toBe(1);
  });

  it("pause sets paused, seek keeps it, play clears it; position and serverTs stored exactly", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await acquireVideoSlotOnce(redis, room, 10, "", draft(10));

    const paused = await updateVideoState(redis, room, 10, 12.345, SERVER_TS + 500, "pause");
    expect(paused).toMatchObject({ paused: true, positionAtTs: 12.345, serverTs: SERVER_TS + 500 });

    const sought = await updateVideoState(redis, room, 10, 60, SERVER_TS + 900, "keep");
    expect(sought).toMatchObject({ paused: true, positionAtTs: 60 });

    const resumed = await updateVideoState(redis, room, 10, 60, SERVER_TS + 1000, "play");
    expect(resumed).toMatchObject({ paused: false, positionAtTs: 60, serverTs: SERVER_TS + 1000 });
    expect(resumed?.source).toEqual({ kind: "youtube", videoId: "dQw4w9WgXcQ" });
  });

  it("a Controller write refreshes BOTH TTLs (the music heartbeat does not)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await acquireVideoSlotOnce(redis, room, 10, "", draft(10));
    await redis.expire(videoPlayerKey(room), 30);
    await redis.expire(videoStateKey(room), 30);

    await updateVideoState(redis, room, 10, 2, SERVER_TS, "play");

    expect(await redis.ttl(videoPlayerKey(room))).toBeGreaterThan(VIDEO_PLAYER_TTL_SECONDS - 5);
    expect(await redis.ttl(videoStateKey(room))).toBeGreaterThan(VIDEO_PLAYER_TTL_SECONDS - 5);
  });

  it("a non-holder write and release change nothing", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    const play = await acquireVideoSlotOnce(redis, room, 10, "", draft(10));

    expect(await updateVideoState(redis, room, 20, 99, SERVER_TS, "pause")).toBeNull();
    expect(await releaseVideoSlot(redis, room, 20)).toBe(false);
    expect(await getVideoPlayerState(redis, room)).toEqual(play.acquired ? play.snapshot : null);
  });

  it("a write with no session returns null", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    expect(await updateVideoState(redis, room, 10, 1, SERVER_TS, "play")).toBeNull();
    expect(await getVideoPlayerState(redis, room)).toBeNull();
  });
});
