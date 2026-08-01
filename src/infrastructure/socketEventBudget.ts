import type { Socket } from "socket.io";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import { metrics } from "@src/infrastructure/metrics.js";
import { seenRecently } from "@src/infrastructure/sentry/dedupe.js";
import { Errors } from "@src/shared/errors.js";

/**
 * platform-security 05: global per-socket event budget.
 *
 * A per-socket, IN-PROCESS token bucket applied ahead of the five existing
 * per-handler Redis limits (chat, gift send/prepare, DM typing, seat
 * reaction — unchanged, see rateLimiter.ts). Those are per-*user* and
 * legitimately need cross-instance state; this budget is a second, cheaper
 * layer in front so a handler with no rate limit of its own — ~25 of 34
 * registered events today, including the entire media path, room join,
 * every seat event and every audio-player event — still has SOME ceiling.
 *
 * Deliberately NOT the Redis sliding-window limiter: that does a network
 * round-trip per call and defaults to DENYING on a Redis error. Putting that
 * on every socket event would add a hop to the hot media path and let a
 * single Redis blip silently drop all traffic on every socket — an outage
 * worse than the abuse this defends against. In-process state needs no
 * cross-instance coordination anyway: a socket connection lives on exactly
 * one instance. Because it never touches an external dependency, there is no
 * fail-policy question — no RATE_LIMIT_FAIL_OPEN-style knob here, on
 * purpose.
 *
 * ── Sizing ──────────────────────────────────────────────────────────────
 * Must be burst-tolerant — a flat per-second rate is WRONG and throttles
 * real users. Two measured floors, both must clear with headroom:
 *
 * Floor 1 — join burst, ≥ ~65 events in the first few seconds:
 *   Cold join costs `3 + 2N` events; reconnect-with-seat-reclaim costs
 *   `7-8 + 2N`, where N = other producers on the room, bounded by
 *   MAX_SEAT_COUNT (30). Worst case: 8 + 2*30 = 68 events.
 *   SOCKET_EVENT_BUDGET_CAPACITY=100 clears this WITHOUT depending on any
 *   refill accruing during the burst (the bucket starts FULL at connection,
 *   not empty-then-filling — see below):
 *     100 / 68 (actual worst case)     ≈ 1.47x headroom
 *     100 / 65 (ticket's stated floor) ≈ 1.54x headroom
 *
 * Floor 2 — sustained rate, ≥ ~5.5 events/sec:
 *   The loosest existing per-handler limit is the gift allowance,
 *   330 requests / 60s = 5.5/sec, and it sits on a revenue path — a global
 *   cap below it would silently override an intentional decision.
 *
 *   That single-handler figure is a MINIMUM, not the number to size against:
 *   the budget is per-SOCKET, so a genuinely busy user can legally run
 *   several rate-limited streams at once on the same connection. Summing
 *   every existing per-handler ceiling plus the one steady periodic
 *   client-driven emit (audioPlayer:stateUpdate, every 2s while DJ'ing):
 *     gift:send        330/60s = 5.5/s  (revenue path)
 *     gift:prepare      330/60s = 5.5/s  (independent key, same limit)
 *     chat               60/60s = 1.0/s
 *     seat reaction        1/1.5s = 0.67/s
 *     DM typing             1/2s = 0.5/s
 *     audioPlayer:stateUpdate      = 0.5/s (frontend setInterval, 2000ms)
 *                                  ─────────
 *                            total ≈ 13.7/s
 *   SOCKET_EVENT_BUDGET_REFILL_PER_SECOND=20 clears both:
 *     20 / 5.5  (ticket's stated single-handler floor) ≈ 3.6x headroom
 *     20 / 13.7 (realistic all-streams-at-once ceiling) ≈ 1.5x headroom
 *   A lower refill (e.g. 10) clears the ticket's stated floor alone but
 *   leaves under 1.3x on the realistic aggregate — thin enough that a truly
 *   enthusiastic gifting-while-chatting session could drain the CAPACITY=100
 *   burst reserve (in ~25-30s at that deficit) and then get throttled below
 *   its own legal per-handler rate. 20 keeps real headroom on both.
 *
 * Both values live in src/config/index.ts and are tunable without a code
 * release.
 */
export interface TokenBucketOptions {
  /** Max tokens the bucket can hold — the size of an instantaneous burst. */
  capacity: number;
  /** Tokens added per second, up to `capacity`. */
  refillPerSecond: number;
  /** Injectable clock for tests. Defaults to wall-clock time. */
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillAt: number;

  constructor({ capacity, refillPerSecond, now = Date.now }: TokenBucketOptions) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    // Starts FULL: a legitimate join burst arrives before any wall-clock
    // time has passed for tokens to refill, so an empty-start bucket would
    // throttle the very first few events of every connection.
    this.tokens = capacity;
    this.lastRefillAt = now();
  }

  /**
   * Attempt to spend `cost` tokens (default 1, i.e. one socket event).
   * Returns true if there was budget, false if the caller should reject.
   */
  consume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSeconds = (nowMs - this.lastRefillAt) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.refillPerSecond,
    );
    this.lastRefillAt = nowMs;
  }
}

/**
 * Build a per-socket budget from the validated config. Call once per
 * connection (see the `io.on("connection", ...)` handler in
 * src/socket/index.ts) and hold the instance in that connection's closure —
 * each socket gets its own bucket; there is no shared state between them.
 */
export function createSocketEventBudget(now?: () => number): TokenBucket {
  return new TokenBucket({
    capacity: config.SOCKET_EVENT_BUDGET_CAPACITY,
    refillPerSecond: config.SOCKET_EVENT_BUDGET_REFILL_PER_SECOND,
    // `exactOptionalPropertyTypes` forbids assigning `now: undefined`
    // explicitly — spread it in only when a caller actually supplied one, so
    // the constructor's own `now = Date.now` default still applies.
    ...(now ? { now } : {}),
  });
}

/**
 * Attach this socket's budget via `socket.use()` — Socket.IO's documented
 * incoming-packet middleware, which runs for EVERY event ahead of any
 * `socket.on(eventName, ...)` listener. That ordering is what puts this budget
 * ahead of the five existing per-handler Redis limits (chat, gift
 * send/prepare, DM typing, seat reaction): those live inside their listeners'
 * own GATE stage and are only dispatched to AFTER this middleware chain
 * accepts the packet, so they are entirely unaffected.
 *
 * Load-bearing: the DISCONNECT packet never reaches `socket.use()` —
 * Socket.IO routes it straight from `onevent()` to `ondisconnect()` /
 * `_onclose()`, bypassing `dispatch()`/`run()` entirely (same for a
 * transport-level close, the dominant mobile path). So a budget-exhausted
 * socket still tears down cleanly and `finalizeLeave()` always runs. If a
 * future Socket.IO upgrade changed that routing, an exhausted socket could
 * leak its seat and leave a room phantom-live — re-check this against any
 * socket.io major bump.
 */
export function installSocketEventBudget(
  socket: Socket,
  budget: TokenBucket = createSocketEventBudget(),
): void {
  socket.use(([eventName, ...args], next) => {
    if (budget.consume()) {
      next();
      return;
    }

    // Answer the caller instead of dropping the packet into a void. Socket.IO
    // appends the ack callback to the packet's args BEFORE the middleware
    // chain runs (`onevent()`: `args.push(this.ack(packet.id))`, then
    // `dispatch(args)`), so the trailing function IS the client's ack.
    // Without this the client's promise never settles and it waits out its
    // own timeout — an "unexplained client error", which is precisely what
    // this ticket's observability criterion rules out. Every handler here
    // already returns this shape and RATE_LIMITED is the error the five
    // per-handler limits already return, so no client needs new handling.
    const ack = args[args.length - 1];
    if (typeof ack === "function") {
      ack({ success: false, error: Errors.RATE_LIMITED });
    }

    // REACT: the counter is unconditional (cheap); the log is deduped so a
    // sustained flood cannot also flood the logger. Deliberately ONE static
    // key, NOT per-socket: `socket.id` is unique per connection, so keying on
    // it would grow `lastSeenAt` without bound. That map is shared with
    // handler.utils.ts's GATE-rejection dedupe, and its ceiling behaviour is
    // capacity-CLEAR, not LRU-evict — overflowing it drops the whole map and
    // would thrash that cache for every other caller. socketId/userId/event
    // still go in the log body; only the dedupe key is collapsed.
    metrics.socketEventBudgetExceeded.inc();
    if (!seenRecently("socket-event-budget")) {
      logger.warn(
        { socketId: socket.id, userId: socket.data.user?.id, event: eventName },
        "Global per-socket event budget exceeded — event dropped",
      );
    }

    // Socket.IO surfaces a middleware rejection as a local "error" event; the
    // no-op listener below is the documented safety valve (an unhandled
    // "error" throws in Node's EventEmitter). The ack, counter and log above
    // have already run.
    next(new Error("event_budget_exceeded"));
  });

  socket.on("error", () => {});
}
