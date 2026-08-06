import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    LARAVEL_API_URL: "http://laravel.test",
    LARAVEL_API_TIMEOUT_MS: 50,
    LARAVEL_INTERNAL_KEY: "test-internal-key-0123456789ab",
    INSTANCE_ID: "i-test-box-1",
  },
}));

// Sentry capture is exercised elsewhere (captureLaravelFailure); stub it out here so a
// deliberately-thrown fetch failure in these tests doesn't try to reach the real SDK.
vi.mock("@sentry/node", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setTags: vi.fn(), setFingerprint: vi.fn() }),
  ),
  captureException: vi.fn(),
}));

import { LaravelClient } from "@src/integrations/laravelClient.js";
import { metrics, metricsRegistry } from "@src/infrastructure/metrics.js";
import { withCorrelation } from "@src/infrastructure/correlation.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Every scrape-relevant counter/histogram this suite touches, reset between tests. */
function resetLaravelApiMetrics() {
  metrics.laravelApiCalls.reset();
  metrics.laravelApiLatency.reset();
}

describe("LaravelClient — correlation header on outbound calls (observability-audio-quality 11)", () => {
  let client: LaravelClient;

  beforeEach(() => {
    client = new LaravelClient(createLogger());
  });

  afterEach(() => {
    client.stopPruner();
    vi.unstubAllGlobals();
  });

  it("sends X-Correlation-ID on a GET when inside a correlated operation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { owner_id: 1, max_seats: null }));
    vi.stubGlobal("fetch", fetchMock);

    await withCorrelation("abc-123", () => client.getRoomData("42"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-Correlation-ID"]).toBe(
      "abc-123",
    );
  });

  it("sends X-Correlation-ID on a POST when inside a correlated operation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { failed: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await withCorrelation("post-corr-id", () =>
      client.processGiftBatch([]),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-Correlation-ID"]).toBe(
      "post-corr-id",
    );
  });

  it("omits X-Correlation-ID entirely outside any correlated operation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { owner_id: 1, max_seats: null }));
    vi.stubGlobal("fetch", fetchMock);

    await client.getRoomData("42");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers as Record<string, string>).not.toHaveProperty(
      "X-Correlation-ID",
    );
  });
});

describe("LaravelClient — dead API metrics wired (observability-audio-quality 14)", () => {
  let client: LaravelClient;

  beforeEach(() => {
    resetLaravelApiMetrics();
    client = new LaravelClient(createLogger());
  });

  afterEach(() => {
    client.stopPruner();
    vi.unstubAllGlobals();
    resetLaravelApiMetrics();
  });

  it("increments laravelApiCalls and observes laravelApiLatency on a successful GET", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { owner_id: 7, max_seats: 8 })),
    );

    await client.getRoomData("42");

    expect(
      await metrics.laravelApiCalls.get(),
    ).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({
          labels: { endpoint: "/api/v1/internal/rooms/:id", status: "200" },
          value: 1,
        }),
      ]),
    });

    const latency = await metrics.laravelApiLatency.get();
    const sample = latency.values.find(
      (v) =>
        v.metricName?.endsWith("_count") &&
        v.labels.endpoint === "/api/v1/internal/rooms/:id",
    );
    expect(sample?.value).toBe(1);
  });

  it("labels a non-2xx response with its real status code, not just successes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom" })),
    );

    // getCascadeInfo swallows non-ok responses internally — the metric must still fire.
    await client.getCascadeInfo("99");

    expect(await metrics.laravelApiCalls.get()).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({
          labels: {
            endpoint: "/api/v1/internal/rooms/:id/cascade-info",
            status: "500",
          },
          value: 1,
        }),
      ]),
    });
  });

  it("labels a network failure as status=error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await client.getMemberRole("1", "2"); // catches internally, resolves null

    expect(await metrics.laravelApiCalls.get()).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({
          labels: {
            endpoint: "/api/v1/internal/rooms/:id/members/:id/role",
            status: "error",
          },
          value: 1,
        }),
      ]),
    });
  });

  it("labels an AbortController timeout as status=timeout, not status=error", async () => {
    // Never resolves/rejects on its own — only the AbortController (50ms, from the
    // mocked LARAVEL_API_TIMEOUT_MS) ends it, so this exercises the REAL timeout path
    // rather than asserting the label from a hand-thrown error shape.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }),
    );

    await expect(
      client.updateRoomStatus("5", { is_live: true, participant_count: 3 }),
    ).resolves.toBeUndefined(); // updateRoomStatus catches and logs, never throws

    expect(await metrics.laravelApiCalls.get()).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({
          labels: {
            endpoint: "/api/v1/internal/rooms/:id/status",
            status: "timeout",
          },
          value: 1,
        }),
      ]),
    });
  }, 10_000);

  it("labels the gift-batch endpoint literally, with no :id segment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { failed: [] })),
    );

    await client.processGiftBatch([]);

    expect(await metrics.laravelApiCalls.get()).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({
          labels: {
            endpoint: "/api/v1/internal/gifts/batch",
            status: "200",
          },
        }),
      ]),
    });
  });

  it("collapses a non-numeric, non-UUID roomId to the same bounded template — never echoes it raw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { owner_id: 1, max_seats: null })),
    );

    // roomIdSchema is z.string().min(1) — nothing stops a caller-supplied,
    // non-numeric value from reaching here. The label must not vary with it.
    await client.getRoomData("junk-not-a-real-id-8f3");

    const values = (await metrics.laravelApiCalls.get()).values;
    expect(values).toHaveLength(1);
    expect(values[0]!.labels.endpoint).toBe("/api/v1/internal/rooms/:id");
    expect(values[0]!.labels.endpoint).not.toContain("junk-not-a-real-id");
  });

  it("strips the query string so a polled endpoint keeps one bounded label", async () => {
    // getRevokedSince is the only call site whose endpoint carries a query string
    // (?since=<timestamp>) — the only template whose match depends on stripping it first.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { revoked: [], server_time: 1 })),
    );

    await client.getRevokedSince(1786000000);
    await client.getRevokedSince(1786000060); // different ?since — must NOT open a second series

    const values = (await metrics.laravelApiCalls.get()).values;
    expect(values).toHaveLength(1);
    expect(values[0]!.labels.endpoint).toBe("/api/v1/internal/users/revoked");
    expect(values[0]!.value).toBe(2);
  });

  it("a Prometheus scrape shows both metrics carrying non-zero values after exercising a call (AC#6)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { owner_id: 1, max_seats: null })),
    );

    await client.getRoomData("1");

    const body = await metricsRegistry.metrics();
    expect(body).toMatch(
      /flylive_laravel_api_calls_total\{endpoint="\/api\/v1\/internal\/rooms\/:id",status="200"\} 1/,
    );
    expect(body).toMatch(
      /flylive_laravel_api_latency_seconds_count\{endpoint="\/api\/v1\/internal\/rooms\/:id"\} 1/,
    );
  });
});
