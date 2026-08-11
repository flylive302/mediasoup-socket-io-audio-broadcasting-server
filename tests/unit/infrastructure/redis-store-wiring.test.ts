import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// aws-platform-build/21 — REGRESSION GUARD.
//
// The store split ships inert: with REDIS_CACHE_HOST unset, getCacheRedisClient()
// RETURNS the durable client, so every mis-wiring below is invisible today and
// every test still passes. The defect only arms at cutover, when the cache store
// becomes a genuinely separate, evict-freely host. That is exactly why a runtime
// test cannot catch it and this source-level guard exists.
//
// Rule: `pubClient` (the cache client) may ONLY back cache-class traffic —
// socket.io pub/sub, rate limits, presence, socket/room maps. Anything that is
// money, a lock, an idempotency guard, or auth state MUST take `durableClient`.

const SERVER_TS = fileURLToPath(
  new URL("../../../src/infrastructure/server.ts", import.meta.url),
);
const source = readFileSync(SERVER_TS, "utf8");

const lines = source.split("\n").map((text, i) => ({ no: i + 1, text }));

/**
 * Every legitimate cache-client use in server.ts. A line mentioning `pubClient`
 * that does not match one of these is a new consumer wired to the evicting
 * store — add it here ONLY after confirming its keys are safe to lose.
 */
const ALLOWED_PUB_CLIENT_USES = [
  /^\s*const pubClient = getCacheRedisClient\(\);$/,
  /^\s*const subClient = pubClient\.duplicate\(\);$/,
  /^\s*adapter: createAdapter\(pubClient, subClient,/,
  /^\s*const appContext = await initializeSocket\(io, durableClient, pubClient\);$/,
];

/**
 * Key classes that must never sit on an evict-freely store, and the call site
 * that wires each one. Value = the fragment that must appear in server.ts.
 */
const DURABLE_CONSUMERS: Array<{ why: string; mustContain: string }> = [
  {
    why: "cascade:room:*:owner is a CAS lock — an evicted key cannot be reclaimed by its own holder, so a rival instance's SETNX wins and both believe they own the room",
    mustContain: "new RoomRegistry(durableClient, logger)",
  },
  {
    why: "the backfill poller writes auth:user_revoked:* and its cursor; auth/middleware.ts reads that key off the DURABLE client, so a cache-store write lands where nothing reads it",
    mustContain: "new RevocationBackfillPoller(\n    durableClient,",
  },
  {
    why: "msab:ingest:dedup:* is the at-least-once dedup gate — an evicting store silently downgrades exactly-once to at-least-once",
    mustContain: "createEventIngestRoutes(eventRouter, durableClient)",
  },
];

describe("aws-platform-build/21 — Redis store wiring in server.ts", () => {
  it("uses the cache client ONLY for cache-class traffic", () => {
    const offenders = lines
      .filter(({ text }) => text.includes("pubClient"))
      .filter(({ text }) =>
        ALLOWED_PUB_CLIENT_USES.every((allowed) => !allowed.test(text)),
      )
      .map(({ no, text }) => `server.ts:${no}  ${text.trim()}`);

    expect(
      offenders,
      `Unexpected cache-client (pubClient) consumer(s).\n` +
        `The cache store is allkeys-lru with no snapshots. If these keys hold money, ` +
        `a lock, an idempotency guard, or auth state, wire them to durableClient instead.\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it.each(DURABLE_CONSUMERS)(
    "wires a durable-class consumer to durableClient ($mustContain)",
    ({ why, mustContain }) => {
      expect(source.includes(mustContain), `${mustContain} — ${why}`).toBe(
        true,
      );
    },
  );

  it("gives the queue consumer the SAME store as the HTTP ingest route", () => {
    // Both transports claim against msab:ingest:dedup:*. If they disagree on the
    // store, the dedup key becomes transport-dependent and the guard is useless.
    const httpIngestIsDurable = source.includes(
      "createEventIngestRoutes(eventRouter, durableClient)",
    );
    const queueConsumerBlock = source.slice(
      source.indexOf("createQueueConsumer({"),
      source.indexOf("createQueueConsumer({") + 300,
    );

    expect(httpIngestIsDurable).toBe(true);
    expect(queueConsumerBlock).toContain("redis: durableClient");
  });

  it("reads music-player state from the store that writes it", () => {
    // audio-player.handler.ts writes room:{id}:musicPlayer / :musicState on the
    // durable client. The cascade internal API reads them back cross-instance.
    const internalRoutesBlock = source.slice(
      source.indexOf("createInternalRoutes({"),
      source.indexOf("{ prefix: \"/\" }"),
    );

    expect(internalRoutesBlock).toContain("redis: durableClient");
    expect(internalRoutesBlock).not.toContain("redis: pubClient");
  });
});
