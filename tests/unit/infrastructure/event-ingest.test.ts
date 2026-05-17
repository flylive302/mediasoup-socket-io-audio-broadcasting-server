import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: { LARAVEL_INTERNAL_KEY: "test-internal-key" },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { createEventIngestRoutes } from "@src/infrastructure/event-ingest.js";

const MAX_CONCURRENT_EVENTS = 100;

function makeEvent(n: number) {
  return {
    event: `e-${n}`,
    user_id: null,
    room_id: null,
    payload: {},
    timestamp: new Date().toISOString(),
    correlation_id: `c-${n}`,
  };
}

describe("event-ingest backpressure (F-40)", () => {
  let app: FastifyInstance;
  let release: () => void;
  let routeCalls: number;

  beforeEach(async () => {
    routeCalls = 0;
    // route() hangs until release() so we can pin N requests in-flight.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventRouter = {
      route: vi.fn(async () => {
        routeCalls++;
        await gate;
        return { delivered: true, targetCount: 1 };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    app = Fastify({ logger: false });
    await app.register(createEventIngestRoutes(eventRouter));
    await app.ready();
  });

  it("sheds with 503 once MAX_CONCURRENT_EVENTS are in flight", async () => {
    const inject = (n: number) =>
      app.inject({
        method: "POST",
        url: "/api/events",
        headers: { "x-internal-key": "test-internal-key" },
        payload: makeEvent(n),
      });

    // Saturate: 100 requests that block inside route().
    const pending = Array.from({ length: MAX_CONCURRENT_EVENTS }, (_, i) =>
      inject(i),
    );
    // Let the 100 reach (and block in) route().
    await vi.waitFor(() => expect(routeCalls).toBe(MAX_CONCURRENT_EVENTS));

    // The next one must be shed without entering route().
    const shed = await inject(999);
    expect(shed.statusCode).toBe(503);
    expect(shed.headers["retry-after"]).toBe("1");
    expect(routeCalls).toBe(MAX_CONCURRENT_EVENTS); // 999 never routed

    // Drain the held requests.
    release();
    const results = await Promise.all(pending);
    for (const r of results) expect(r.statusCode).toBe(200);

    // Capacity recovered.
    const after = await inject(1000);
    expect(after.statusCode).toBe(200);
  });

  it("rejects unauthorized requests with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "x-internal-key": "wrong" },
      payload: makeEvent(1),
    });
    expect(res.statusCode).toBe(401);
  });
});
