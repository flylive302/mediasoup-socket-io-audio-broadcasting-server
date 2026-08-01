import { describe, it, expect, vi } from "vitest";
import {
  TokenBucket,
  createSocketEventBudget,
  installSocketEventBudget,
} from "@src/infrastructure/socketEventBudget.js";
import { config } from "@src/config/index.js";
import { Errors } from "@src/shared/errors.js";

// platform-security 05: global per-socket event budget. In-process only, so
// this is a pure test over a clock and a counter — no Redis mock needed
// (unlike tests/unit/utils/rateLimiter.test.ts, which mocks a Redis client).
// Every scenario asserts against the real, Zod-validated config values
// (SOCKET_EVENT_BUDGET_CAPACITY / _REFILL_PER_SECOND, plus the existing
// MAX_SEAT_COUNT / GIFT_RATE_LIMIT / GIFT_RATE_WINDOW knobs the ticket's two
// floors are derived from) rather than hardcoded numbers, so the suite keeps
// asserting the right thing if any of those defaults are ever retuned.

function newBucket(now: () => number): TokenBucket {
  return new TokenBucket({
    capacity: config.SOCKET_EVENT_BUDGET_CAPACITY,
    refillPerSecond: config.SOCKET_EVENT_BUDGET_REFILL_PER_SECOND,
    now,
  });
}

describe("TokenBucket (global per-socket event budget)", () => {
  it("permits a burst at the join floor (~65 events) with no elapsed time", () => {
    let now = 0;
    const bucket = newBucket(() => now);

    // Ticket floor: "join burst ≥ ~65 events in the first few seconds must
    // be permitted". Zero elapsed time is the strictest case — no refill can
    // help, so this proves the starting CAPACITY alone clears the floor.
    const JOIN_FLOOR = 65;
    for (let i = 0; i < JOIN_FLOOR; i++) {
      expect(bucket.consume()).toBe(true);
    }
  });

  it("permits the worst-case reconnect-with-seat-reclaim burst (7-8 + 2*MAX_SEAT_COUNT)", () => {
    let now = 0;
    const bucket = newBucket(() => now);

    // Ticket evidence: reconnect-with-seat-reclaim costs 7-8 + 2N events,
    // N = other producers, bounded by MAX_SEAT_COUNT. Use the upper bound (8)
    // for the worst case.
    const WORST_CASE_JOIN_BURST = 8 + 2 * config.MAX_SEAT_COUNT;
    for (let i = 0; i < WORST_CASE_JOIN_BURST; i++) {
      expect(bucket.consume()).toBe(true);
    }
  });

  it("permits a sustained rate at the gift allowance (GIFT_RATE_LIMIT / GIFT_RATE_WINDOW)", () => {
    let now = 0;
    const bucket = newBucket(() => now);

    // Spend the starting burst allowance up front (at t=0, no refill yet) so
    // the remainder of the test is genuinely bounded by the refill rate, not
    // riding on leftover capacity.
    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_CAPACITY; i++) {
      bucket.consume();
    }

    // The existing gift allowance — the loosest per-handler limit, on a
    // revenue path — is the ticket's sustained-rate floor. Replay it as
    // GIFT_RATE_LIMIT events evenly spaced across GIFT_RATE_WINDOW seconds.
    const events = config.GIFT_RATE_LIMIT;
    const windowMs = config.GIFT_RATE_WINDOW * 1000;
    const intervalMs = windowMs / events;

    for (let i = 0; i < events; i++) {
      now += intervalMs;
      expect(bucket.consume()).toBe(true);
    }
  });

  it("rejects traffic beyond the configured budget", () => {
    let now = 0;
    const bucket = newBucket(() => now);

    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_CAPACITY; i++) {
      expect(bucket.consume()).toBe(true);
    }
    // Same instant — nothing has had time to refill.
    expect(bucket.consume()).toBe(false);
  });

  it("refills over time", () => {
    let now = 0;
    const bucket = newBucket(() => now);

    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_CAPACITY; i++) {
      bucket.consume();
    }
    expect(bucket.consume()).toBe(false); // drained

    now += 1_000; // 1 second later

    // Exactly REFILL_PER_SECOND tokens should now be available — no more.
    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_REFILL_PER_SECOND; i++) {
      expect(bucket.consume()).toBe(true);
    }
    expect(bucket.consume()).toBe(false);
  });

  it("caps refill at capacity — idle time doesn't bank unbounded tokens", () => {
    let now = 0;
    const bucket = newBucket(() => now);

    now += 1_000 * 1_000; // a very long idle period
    let allowed = 0;
    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_CAPACITY + 50; i++) {
      if (bucket.consume()) allowed++;
    }
    expect(allowed).toBe(config.SOCKET_EVENT_BUDGET_CAPACITY);
  });

  it("gives two sockets independent budgets", () => {
    const now = 0;
    const socketA = newBucket(() => now);
    const socketB = newBucket(() => now);

    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_CAPACITY; i++) {
      expect(socketA.consume()).toBe(true);
    }
    expect(socketA.consume()).toBe(false); // A is fully drained

    // B was never touched — draining A must not affect B's independent bucket.
    expect(socketB.consume()).toBe(true);
  });

  it("createSocketEventBudget() wires capacity/refill from config", () => {
    let now = 0;
    const bucket = createSocketEventBudget(() => now);

    for (let i = 0; i < config.SOCKET_EVENT_BUDGET_CAPACITY; i++) {
      expect(bucket.consume()).toBe(true);
    }
    expect(bucket.consume()).toBe(false);
  });

  it("makes no Redis call on the global-budget path — consume() resolves synchronously", () => {
    const bucket = createSocketEventBudget(() => 0);

    // A Redis-backed check (see RateLimiter.isAllowed) is necessarily async —
    // it awaits a network round trip and returns a Promise<boolean>.
    // TokenBucket.consume() returns a plain boolean with no `await` anywhere
    // in its call path: this synchronous, non-Promise return is the proof
    // there is no I/O — Redis or otherwise — on this path.
    const result = bucket.consume();
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe("boolean");
    expect(result).toBe(true);
  });
});

// ─── Middleware wiring ───────────────────────────────────────────────
//
// The budget only helps if a throttled client is TOLD. Socket.IO appends the
// ack callback to the packet args before the middleware chain runs, so a
// rejection can answer the caller instead of leaving its promise unsettled
// until a client-side timeout — which would be the "unexplained client error"
// the ticket's observability criterion rules out.

type Middleware = (event: unknown[], next: (err?: Error) => void) => void;

function mockSocket() {
  let middleware: Middleware | undefined;
  return {
    id: "socket-1",
    data: { user: { id: 7 } },
    use: (fn: Middleware) => {
      middleware = fn;
    },
    on: () => {},
    dispatch: (event: unknown[]) => {
      const next = vi.fn();
      middleware!(event, next);
      return next;
    },
  };
}

describe("installSocketEventBudget", () => {
  it("passes events through while the socket is inside its budget", () => {
    const socket = mockSocket();
    installSocketEventBudget(socket as unknown as import("socket.io").Socket);

    const ack = vi.fn();
    const next = socket.dispatch(["chat:message", { roomId: "r" }, ack]);

    expect(next).toHaveBeenCalledWith();
    expect(ack).not.toHaveBeenCalled();
  });

  it("answers the client's ack with the existing RATE_LIMITED error once exhausted", () => {
    const socket = mockSocket();
    installSocketEventBudget(
      socket as unknown as import("socket.io").Socket,
      new TokenBucket({ capacity: 1, refillPerSecond: 0.0001, now: () => 0 }),
    );

    socket.dispatch(["chat:message", {}, vi.fn()]); // spends the only token

    const ack = vi.fn();
    const next = socket.dispatch(["chat:message", {}, ack]);

    expect(ack).toHaveBeenCalledWith({ success: false, error: Errors.RATE_LIMITED });
    // Rejected, so the packet never reaches the handler.
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not blow up on an event the client sent without an ack", () => {
    const socket = mockSocket();
    installSocketEventBudget(
      socket as unknown as import("socket.io").Socket,
      new TokenBucket({ capacity: 0, refillPerSecond: 0.0001, now: () => 0 }),
    );

    expect(() => socket.dispatch(["seat:reaction", { roomId: "r" }])).not.toThrow();
  });
});
