import { describe, it, expect, vi, beforeEach } from "vitest";

// aws-production 32.
//
// The poller's single `try` wrapped BOTH the Laravel HTTP call and the Redis
// cursor/key writes, and its catch recorded a Redis degradation for all of it.
// On any environment whose `LARAVEL_API_URL` is unreachable — staging's is
// NXDOMAIN by design, so 24 load bots can't reach production — that booked a
// Laravel outage as a state-store outage once every 60 s, forever, against a
// counter whose documented steady state is zero and which carries a fleet-wide
// CloudWatch alarm. It also hard-failed the load harness's Q10 gate.
//
// What these tests pin is attribution, not counting: which side of the poll
// failed, and therefore which metric is allowed to move.

vi.mock("@src/config/index.js", () => ({
  config: { JWT_MAX_AGE_SECONDS: 3600 },
}));

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { redisDegradations: { inc: vi.fn() } },
}));

import { RevocationBackfillPoller } from "@src/integrations/laravel/revocation-backfill-poller.js";
import { metrics } from "@src/infrastructure/metrics.js";

const CURSOR_KEY = "msab:revocation_poll:since";

function createMockRedis() {
  return {
    get: vi.fn().mockResolvedValue("1000"),
    set: vi.fn().mockResolvedValue("OK"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockLaravelClient(
  revoked: Array<{ user_id: number; revoked_at: number }> = [],
) {
  return {
    getRevokedSince: vi
      .fn()
      .mockResolvedValue({ revoked, server_time: 2000 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// `pollOnce` is private and normally driven by setInterval. Call it directly so
// the attribution assertions don't depend on timer plumbing.
function poll(p: RevocationBackfillPoller): Promise<void> {
  return (p as unknown as { pollOnce(): Promise<void> }).pollOnce();
}

describe("RevocationBackfillPoller — failure attribution (aws-production 32)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let laravelClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    laravelClient = createMockLaravelClient();
    logger = createMockLogger();
  });

  function build() {
    return new RevocationBackfillPoller(redis, laravelClient, logger);
  }

  // ─── The defect ───────────────────────────────────────────────

  it("does NOT record a Redis degradation when the Laravel call fails", async () => {
    // The exact staging failure: DNS resolution of LARAVEL_API_URL fails.
    laravelClient.getRevokedSince.mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND app.staging.flyliveapp.com"),
    );

    await poll(build());

    expect(metrics.redisDegradations.inc).not.toHaveBeenCalled();
  });

  it("still records a Redis degradation when the cursor READ fails", async () => {
    redis.get.mockRejectedValue(new Error("READONLY"));

    await poll(build());

    expect(metrics.redisDegradations.inc).toHaveBeenCalledWith({
      subsystem: "revocation-backfill",
      operation: "read",
    });
  });

  it("still records a Redis degradation when a revocation-key WRITE fails", async () => {
    laravelClient = createMockLaravelClient([{ user_id: 7, revoked_at: 1500 }]);
    redis.set.mockRejectedValue(new Error("READONLY"));

    await poll(build());

    expect(metrics.redisDegradations.inc).toHaveBeenCalledWith({
      subsystem: "revocation-backfill",
      operation: "write",
    });
  });

  it("still records a Redis degradation when the cursor WRITE fails", async () => {
    // No revocations, so the only `set` is the cursor advance.
    redis.set.mockRejectedValue(new Error("READONLY"));

    await poll(build());

    expect(metrics.redisDegradations.inc).toHaveBeenCalledWith({
      subsystem: "revocation-backfill",
      operation: "write",
    });
  });

  // ─── Rate semantics ───────────────────────────────────────────

  it("emits exactly ONE increment per failed poll, not one per key", async () => {
    // The alarm is a RATE over this counter, so per-key counting would change
    // what operators see even though the fault is identical.
    laravelClient = createMockLaravelClient([
      { user_id: 1, revoked_at: 1500 },
      { user_id: 2, revoked_at: 1501 },
      { user_id: 3, revoked_at: 1502 },
    ]);
    redis.set.mockRejectedValue(new Error("READONLY"));

    await poll(build());

    expect(metrics.redisDegradations.inc).toHaveBeenCalledTimes(1);
  });

  it("emits nothing on the healthy path", async () => {
    laravelClient = createMockLaravelClient([{ user_id: 7, revoked_at: 1500 }]);

    await poll(build());

    expect(metrics.redisDegradations.inc).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      "auth:user_revoked:7",
      "1500",
      "EX",
      3600,
    );
    expect(redis.set).toHaveBeenCalledWith(CURSOR_KEY, "2000");
  });

  // ─── Control flow must be unchanged ───────────────────────────
  //
  // platform-security 07 declined this fix because "splitting the try would
  // change control flow". Attributing at the throw site does not — these pin
  // that.

  it("still aborts the poll on a Laravel failure, leaving the cursor unadvanced", async () => {
    laravelClient.getRevokedSince.mockRejectedValue(new Error("ENOTFOUND"));

    await poll(build());

    expect(redis.set).not.toHaveBeenCalled();
  });

  it("still aborts before calling Laravel when the cursor read fails", async () => {
    redis.get.mockRejectedValue(new Error("READONLY"));

    await poll(build());

    expect(laravelClient.getRevokedSince).not.toHaveBeenCalled();
  });

  it("never rejects — setInterval calls it unawaited, so a throw would be unhandled", async () => {
    redis.get.mockRejectedValue(new Error("READONLY"));

    await expect(poll(build())).resolves.toBeUndefined();
  });

  it("keeps the re-entrancy guard: a second poll no-ops while one is in flight", async () => {
    let release: (v: { revoked: []; server_time: number }) => void = () => {};
    laravelClient.getRevokedSince.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const poller = build();

    const first = poll(poller);
    await poll(poller); // must return immediately without touching Redis again

    expect(redis.get).toHaveBeenCalledTimes(1);

    release({ revoked: [], server_time: 2000 });
    await first;
  });

  // ─── Operator-facing signal ───────────────────────────────────

  it("labels the log line `laravel` when the HTTP call is what failed", async () => {
    laravelClient.getRevokedSince.mockRejectedValue(new Error("ENOTFOUND"));

    await poll(build());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "laravel" }),
      "Revocation backfill poll failed",
    );
  });

  it("labels the log line `redis` when a Redis call is what failed", async () => {
    redis.get.mockRejectedValue(new Error("READONLY"));

    await poll(build());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "redis" }),
      "Revocation backfill poll failed",
    );
  });

  it("keeps the original Redis error reachable on `cause` for the log", async () => {
    const original = new Error("READONLY You can't write against a read only replica");
    redis.get.mockRejectedValue(original);

    await poll(build());

    const [logged] = logger.warn.mock.calls[0] as [{ err: Error }];
    expect(logged.err.cause).toBe(original);
  });
});
