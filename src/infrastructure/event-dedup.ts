/**
 * Event Ingest Deduplication — GATE for the Laravel → MSAB event path.
 *
 * Laravel delivers realtime events **at-least-once**, today, on the current
 * Vultr transport: `DeliverRealtimeEvent` runs with `$tries = 3` and
 * `$backoff = [2, 10, 30]` (backend/app/Jobs/Realtime/DeliverRealtimeEvent.php:41,52).
 * A 5xx or timeout AFTER this server already applied an event produces a real
 * redelivery — which, without this gate, re-applies blocks, revocations and
 * seat shrinks. A managed queue would only make that routine rather than rare.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE KEY IS NOT `correlation_id` ALONE — DO NOT "SIMPLIFY" THIS
 * ─────────────────────────────────────────────────────────────────────────────
 * `correlation_id` is **request-scoped, not event-scoped**. One Laravel HTTP
 * request stamps the SAME id onto every event it emits
 * (backend/app/Support/RequestContext.php:39,71-77 →
 *  backend/app/Services/Realtime/RealtimeTransport.php:91-98).
 *
 * The kick path emits twice inside one request
 * (backend/app/Services/Realtime/Emitters/RoomEventEmitter.php:116-117):
 *
 *     $this->emit('room.member_removed', $payload, $userId);        // user_id set, room_id NULL
 *     $this->emit('room.member_removed', $payload, null, $roomId);  // user_id NULL, room_id set
 *
 * Same correlation_id, same payload, and `now()->toIso8601String()` is
 * second-precision so usually the same timestamp too. The ONLY difference is
 * which of user_id/room_id is populated.
 *
 * MSAB gates the seat-ejection machinery on the room-broadcast copy
 * (event-router.ts, `event.room_id !== null`). Deduplicating on bare
 * `correlation_id` would therefore drop that copy and leave a blocked user
 * sitting in their seat — re-opening the exact defect ADR 0017 / room-blocks 02
 * closed. Hence the key spans the whole logical envelope, not just the id.
 *
 * `timestamp` is deliberately EXCLUDED from the key: it is optional on the wire
 * and a sender that omits it must not defeat deduplication.
 */
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { LaravelEvent } from "@src/integrations/laravel/types.js";
import { config } from "@src/config/index.js";

/**
 * How long a processed event stays remembered.
 *
 * Worst-case redelivery window on the live transport is the job's three
 * attempts with `[2, 10, 30]`s backoff ≈ 42s, plus queue latency. 600s gives
 * more than 10× margin over that while bounding worst-case key count to
 * (event rate × 600) — at a few hundred events/minute that is a five-figure
 * key count, not a memory concern. Raise this when the queue switch lands
 * (tickets 25/26) if its visibility timeout exceeds this window.
 */
export const DEDUP_TTL_SECONDS = 600;

/**
 * Key namespace.
 *
 * MSAB's `REDIS_DB` defaults to 3 — the same index Laravel reserves for its
 * durable connection (`REDIS_DURABLE_DB`, backend/config/database.php). Today
 * the two run on different hosts so nothing collides, but an AWS consolidation
 * onto one ElastiCache would put them in the same keyspace, so a namespace here
 * must be *proven* free rather than assumed.
 *
 * Two independent reasons it is:
 *  1. Laravel prefixes EVERY Redis key it writes with `backend-database-`
 *     (backend/config/database.php:109 `REDIS_PREFIX`). MSAB writes bare keys,
 *     so no MSAB key can collide with a Laravel key by construction. Note that
 *     Laravel's own `msab:user_revoked`
 *     (backend/app/Services/Auth/MsabRevocationService.php:35) is therefore
 *     stored as `backend-database-msab:user_revoked` — it does not occupy the
 *     bare `msab:` namespace this file uses.
 *  2. The only bare `msab:` key MSAB itself writes is
 *     `msab:revocation_poll:since` (integrations/laravel/revocation-backfill-poller.ts:22).
 *     `msab:ingest:` is unused on both sides.
 */
const KEY_PREFIX = "msab:ingest:dedup";

/**
 * The zod schema defaults an absent `correlation_id` to this literal. Every
 * correlation-less event would otherwise share one dedup key and collapse into
 * a single delivery, so events carrying it skip the gate entirely (fail-open).
 */
const ABSENT_CORRELATION_ID = "unknown";

/**
 * Stable JSON: object keys sorted at every depth, so two structurally identical
 * payloads that happened to serialise in a different key order still hash the
 * same. Arrays keep their order — order is meaningful there.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/**
 * The dedup key for one logical delivery, or `null` when the event must skip
 * the gate (no usable correlation id).
 *
 * Instance-scoped on purpose. MSAB's Redis is shared fleet-wide — the
 * socket.io adapter is built on the same client (infrastructure/server.ts) —
 * while Laravel fans the SAME envelope out to every endpoint in
 * `MSAB_EVENT_URLS` (RealtimeTransport.php:100-102) precisely so that each
 * instance routes it to its own local sockets. A fleet-wide key would make the
 * first instance to arrive suppress the event for all the others. Scoping by
 * instance suppresses redelivery to the same instance — the actual at-least-once
 * defect — and changes nothing about fan-out. The fan-out problem (each
 * instance's adapter emit ALSO reaching the whole fleet) is owned by the
 * fleet-scoped claim below (`buildFanoutClaimKey`), which elects one emitter
 * without stopping the others from processing their copy.
 */
export function buildDedupKey(event: LaravelEvent): string | null {
  const fingerprint = eventFingerprint(event);
  if (fingerprint === null) {
    return null;
  }

  // INSTANCE_ID is resolved at boot from IMDSv2 / hostname; the fallback keeps
  // the key well-formed on a host where neither answered, at the cost of that
  // host sharing a namespace with any other equally-unidentified host.
  const instance = config.INSTANCE_ID || "unidentified";

  return `${KEY_PREFIX}:${instance}:${fingerprint}`;
}

/**
 * The whole-envelope fingerprint shared by the per-instance dedup key and the
 * fleet-wide fan-out claim, or `null` when the event has no usable correlation
 * id (both gates fail open in that case).
 */
function eventFingerprint(event: LaravelEvent): string | null {
  if (!event.correlation_id || event.correlation_id === ABSENT_CORRELATION_ID) {
    return null;
  }

  return createHash("sha256")
    .update(
      JSON.stringify([
        event.correlation_id,
        event.event,
        event.user_id,
        event.room_id,
        canonicalize(event.payload),
      ]),
    )
    .digest("hex");
}

/**
 * Fleet-wide fan-out claim key (aws-production 22) — deliberately NOT
 * instance-scoped, unlike `buildDedupKey` above.
 *
 * Two redundant fan-out mechanisms exist: Laravel POSTs the same envelope to
 * every instance, and every `io.to(...).emit()` rides the Redis adapter
 * fleet-wide. On an N-instance fleet a client therefore receives each event
 * N times. Every instance must still PROCESS its copy (Redis mirrors, local
 * socket-data sync, seat ejection are per-instance work), so the ingest dedup
 * key above stays instance-scoped — but only ONE instance may perform the
 * adapter emit. This key elects that instance: first SET NX wins and emits;
 * everyone else skips the emit and does the local work only.
 *
 * Under the SQS transport (single competing consumer per event) exactly one
 * instance ingests, wins this claim trivially, and the adapter emit still
 * reaches the whole fleet — the claim is a no-op there, not a hazard.
 */
export function buildFanoutClaimKey(event: LaravelEvent): string | null {
  const fingerprint = eventFingerprint(event);
  if (fingerprint === null) {
    return null;
  }
  return `${KEY_PREFIX}:fanout:${fingerprint}`;
}

/**
 * Claim the fleet-wide adapter emit for one event. `true` = this instance
 * emits; `false` = another instance already emitted.
 *
 * Suppresses ONLY on positive evidence (SET NX answering `null`, i.e. the key
 * already exists). Any error — and any non-Redis stand-in that answers
 * something other than `null` — resolves to `true`: a duplicated toast is a
 * far smaller incident than a silently dropped event.
 */
export async function claimFanoutEmit(
  redis: Redis,
  key: string,
  ttlSeconds: number = DEDUP_TTL_SECONDS,
): Promise<boolean> {
  try {
    const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
    return result !== null;
  } catch {
    return true;
  }
}

/**
 * Claim an event for processing. `true` means "first time, go ahead"; `false`
 * means "already processed, drop it".
 *
 * FAILS OPEN. A Redis error resolves to `true` — a duplicated event is a far
 * smaller incident than every event being dropped for the duration of a Redis
 * blip. Same fail-policy reasoning as the room-block mirror read.
 */
export async function claimEvent(
  redis: Redis,
  key: string,
  ttlSeconds: number = DEDUP_TTL_SECONDS,
): Promise<boolean> {
  try {
    const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch {
    return true;
  }
}

/**
 * Hand a claim back so a retry of the same envelope is allowed through.
 *
 * Insurance only, not the correctness story: `EventRouter.route()` catches
 * everything internally and returns a result object, and the ingest route
 * answers 200 even for a routing error — so Laravel does not retry that case
 * anyway. This covers a throw from outside `route()`'s own try/catch.
 */
export async function releaseClaim(redis: Redis, key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    // Intentionally empty — the claim expires on its own within DEDUP_TTL_SECONDS.
  }
}
