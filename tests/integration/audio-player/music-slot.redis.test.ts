/**
 * room-music-playlist 03 + 04 + 05 — the music Lua scripts against a REAL Redis.
 *
 * The handler unit tests mock `redis.eval`, so they never run a line of Lua. This
 * file is the seam that proves:
 *   03  audioPlayer:stateUpdate is ONE script: holder check + mutex refresh + state
 *       write. A non-holder writes nothing; a missing musicState is never created
 *       (a release between the old GET and SETEX used to resurrect it); the mutex
 *       TTL is refreshed; cjson round-trips every musicState field.
 *   04  a Room Video starting (play or owner takeover) clears the music waiting
 *       line in the SAME script that grants the video, and reports how many.
 *   05  promoteIfFree grants nothing while a Room Video holds the slot.
 *
 * Address: MSAB_TEST_REDIS_URL, else REDIS_HOST/REDIS_PORT db 15 (same as
 * video-state.redis.test.ts). Skipped LOUDLY when no Redis answers. Each test uses
 * its own room id and deletes only its own keys; the db is never flushed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  musicPlayerKey,
  musicStateKey,
  musicQueueKey,
  promoteIfFree,
  MUSIC_PLAYER_TTL_SECONDS,
  MUSIC_GRANT_GRACE_TTL_SECONDS,
} from "@src/domains/audio-player/audio-player.queue.js";
import { updateMusicPlaybackState } from "@src/domains/audio-player/audio-player.redis.js";
import { videoPlayerKey, videoStateKey, type VideoSnapshot } from "@src/domains/video-player/video-player.redis.js";
import { acquireVideoSlotOnce, NO_STEAL } from "@src/domains/video-player/media-slot.redis.js";

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
      `\n⚠️  music-slot.redis.test.ts SKIPPED — no Redis at ${url}. ` +
        `Set MSAB_TEST_REDIS_URL to run the music Lua suite.\n`,
    );
  }
});

afterAll(async () => {
  await redis?.quit();
});

let roomCounter = 0;
const usedRooms: string[] = [];
function freshRoom(): string {
  const id = `test-music-${Date.now()}-${++roomCounter}`;
  usedRooms.push(id);
  return id;
}

afterEach(async () => {
  if (!redis) return;
  const keys = usedRooms.flatMap((r) => [
    musicPlayerKey(r),
    musicStateKey(r),
    musicQueueKey(r),
    videoPlayerKey(r),
    videoStateKey(r),
  ]);
  if (keys.length) await redis.del(...keys);
  usedRooms.length = 0;
});

const STARTED_AT = 1_731_068_400_123; // 13 digits — must survive cjson exactly

function musicState(userId: number, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    title: "Ünïcode \"quoted\" / title 🎵",
    duration: 215.5,
    startedAt: STARTED_AT,
    isPaused: false,
    position: 0,
    ...overrides,
  };
}

async function holdMusic(room: string, userId: number, ttl = MUSIC_PLAYER_TTL_SECONDS, withState = true) {
  await redis!.set(musicPlayerKey(room), String(userId), "EX", ttl);
  if (withState) {
    await redis!.set(musicStateKey(room), JSON.stringify(musicState(userId)), "EX", ttl);
  }
}

describe("audioPlayer:stateUpdate Lua (room-music-playlist/03, real Redis)", () => {
  it("a non-holder is denied and nothing is written", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 20, 100);
    const before = await redis.get(musicStateKey(room));

    expect(await updateMusicPlaybackState(redis, room, 10, 99, true)).toBe(false);

    expect(await redis.get(musicStateKey(room))).toBe(before);
    expect(await redis.get(musicPlayerKey(room))).toBe("20");
    // TTLs untouched: a denied update must not refresh anything.
    expect(await redis.ttl(musicPlayerKey(room))).toBeLessThanOrEqual(100);
    expect(await redis.ttl(musicStateKey(room))).toBeLessThanOrEqual(100);
  });

  it("a caller with no mutex at all is denied and no musicState appears", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();

    expect(await updateMusicPlaybackState(redis, room, 10, 5, false)).toBe(false);

    expect(await redis.exists(musicPlayerKey(room), musicStateKey(room))).toBe(0);
  });

  it("the holder with musicState missing does NOT create it (the resurrected-state race)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 10, MUSIC_GRANT_GRACE_TTL_SECONDS, false);

    expect(await updateMusicPlaybackState(redis, room, 10, 42, false)).toBe(true);

    expect(await redis.exists(musicStateKey(room))).toBe(0);
  });

  it("the holder updates position + isPaused in place and refreshes BOTH TTLs", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 10, 100);

    expect(await updateMusicPlaybackState(redis, room, 10, 42.25, true)).toBe(true);

    expect(JSON.parse((await redis.get(musicStateKey(room)))!)).toEqual(
      musicState(10, { position: 42.25, isPaused: true }),
    );
    expect(await redis.get(musicPlayerKey(room))).toBe("10");
    // The 2 h backstop is restored on both keys — a >2 h session keeps its mutex.
    expect(await redis.ttl(musicPlayerKey(room))).toBeGreaterThan(MUSIC_PLAYER_TTL_SECONDS - 5);
    expect(await redis.ttl(musicStateKey(room))).toBeGreaterThan(MUSIC_PLAYER_TTL_SECONDS - 5);
  });

  it("cjson round-trip keeps userId, the 13-digit startedAt and the unicode title exact; resume clears isPaused", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 10);

    await updateMusicPlaybackState(redis, room, 10, 12, true);
    await updateMusicPlaybackState(redis, room, 10, 13, false);

    const stored = JSON.parse((await redis.get(musicStateKey(room)))!) as ReturnType<typeof musicState>;
    expect(stored.startedAt).toBe(STARTED_AT);
    expect(stored.userId).toBe(10);
    expect(stored.title).toBe(musicState(10).title);
    expect(stored.duration).toBe(215.5);
    expect(stored.position).toBe(13);
    expect(stored.isPaused).toBe(false);
  });

  it("an unparseable stored state is left alone (never overwritten with a half-built object)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await redis.set(musicPlayerKey(room), "10", "EX", 100);
    await redis.set(musicStateKey(room), "not-json{", "EX", 100);

    expect(await updateMusicPlaybackState(redis, room, 10, 7, false)).toBe(true);

    expect(await redis.get(musicStateKey(room))).toBe("not-json{");
  });
});

describe("promoteIfFree Lua — video guard (room-music-playlist/05, real Redis)", () => {
  it("grants nothing while a Room Video holds the slot — queue untouched, no musicPlayer written", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await redis.set(videoPlayerKey(room), "77", "EX", 100);
    await redis.rpush(musicQueueKey(room), "20", "30");

    expect(await promoteIfFree(redis, room)).toBe("");

    expect(await redis.lrange(musicQueueKey(room), 0, -1)).toEqual(["20", "30"]);
    expect(await redis.exists(musicPlayerKey(room))).toBe(0);
  });

  it("still promotes the head with the provisional grace TTL when the slot is free (regression)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await redis.rpush(musicQueueKey(room), "20", "30");

    expect(await promoteIfFree(redis, room)).toBe("20");

    expect(await redis.get(musicPlayerKey(room))).toBe("20");
    expect(await redis.ttl(musicPlayerKey(room))).toBeLessThanOrEqual(MUSIC_GRANT_GRACE_TTL_SECONDS);
    expect(await redis.lrange(musicQueueKey(room), 0, -1)).toEqual(["30"]);
  });

  it("still no-ops while the music slot is held (regression)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 10);
    await redis.rpush(musicQueueKey(room), "20");

    expect(await promoteIfFree(redis, room)).toBe("");
    expect(await redis.lrange(musicQueueKey(room), 0, -1)).toEqual(["20"]);
  });
});

describe("video acquire clears the music waiting line (room-music-playlist/04, real Redis)", () => {
  const draft = (userId: number): Omit<VideoSnapshot, "revision"> => ({
    controllerUserId: userId,
    source: { kind: "youtube", videoId: "dQw4w9WgXcQ" },
    paused: false,
    positionAtTs: 0,
    serverTs: STARTED_AT,
  });

  it("a video start with 2 waiters deletes musicQueue and reports a cleared count of 2", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await redis.rpush(musicQueueKey(room), "20", "30");

    const res = await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL);

    expect(res).toMatchObject({ acquired: true, clearedMusicQueue: 2 });
    expect(await redis.exists(musicQueueKey(room))).toBe(0);
    expect(await redis.get(videoPlayerKey(room))).toBe("10");
  });

  it("a video start with an empty queue reports 0", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();

    const res = await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL);

    expect(res).toMatchObject({ acquired: true, clearedMusicQueue: 0 });
  });

  it("the DJ starting a video over their own music releases it AND clears the line behind them", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 10);
    await redis.rpush(musicQueueKey(room), "20", "30", "40");

    const res = await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL);

    expect(res).toMatchObject({ acquired: true, releasedMusic: "10", clearedMusicQueue: 3 });
    expect(await redis.exists(musicPlayerKey(room), musicStateKey(room), musicQueueKey(room))).toBe(0);
  });

  it("an owner takeover clears the line too, over a foreign DJ", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 55);
    await redis.rpush(musicQueueKey(room), "20", "30");

    const res = await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL, true);

    expect(res).toMatchObject({ acquired: true, releasedMusic: "55", clearedMusicQueue: 2 });
    expect(await redis.exists(musicQueueKey(room))).toBe(0);
  });

  it("a REFUSED video start leaves the line alone (the clear only follows a grant)", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await holdMusic(room, 55);
    await redis.rpush(musicQueueKey(room), "20", "30");

    const res = await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL);

    expect(res).toEqual({ acquired: false, heldBy: "music", holder: "55" });
    expect(await redis.lrange(musicQueueKey(room), 0, -1)).toEqual(["20", "30"]);
  });

  it("a Controller re-playing their own video (empty line) reports 0 and keeps the revision rule", async ({ skip }) => {
    if (!available || !redis) return skip();
    const room = freshRoom();
    await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL);

    const again = await acquireVideoSlotOnce(redis, room, 10, draft(10), NO_STEAL);

    expect(again).toMatchObject({ acquired: true, clearedMusicQueue: 0 });
    expect(again.acquired && again.snapshot.revision).toBe(2);
  });
});
