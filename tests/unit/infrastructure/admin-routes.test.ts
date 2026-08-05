import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config — mirrors tests/unit/infrastructure/drain.test.ts, plus a
// PREVIOUS key so rotation-overlap auth can be exercised through the
// extracted `isAuthorizedAdmin` helper.
vi.mock("@src/config/index.js", () => ({
  config: {
    LARAVEL_INTERNAL_KEY: "test-key-123",
    LARAVEL_INTERNAL_KEY_PREVIOUS: "old-key-456",
    NODE_ENV: "test",
  },
}));

// Mock logger — mirrors tests/unit/infrastructure/drain.test.ts.
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock Redis so the health-check sub-case doesn't need a live connection.
// health.ts calls getRedisClient().ping() when not draining.
vi.mock("@src/infrastructure/redis.js", () => ({
  getRedisClient: () => ({ ping: vi.fn().mockResolvedValue("PONG") }),
}));

import Fastify from "fastify";
import {
  createAdminRoutes,
  isDraining,
  isDrained,
  getDrainReport,
  resetDrain,
} from "@src/infrastructure/drain.js";
import { createHealthRoutes } from "@src/infrastructure/health.js";

const VALID_KEY = "test-key-123";
const PREVIOUS_KEY = "old-key-456";
const AUTH_HEADERS = { "x-internal-key": VALID_KEY };

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRoomManager(initialRoomCount = 0) {
  let roomCount = initialRoomCount;
  return {
    getRoomCount: vi.fn(() => roomCount),
    _setRoomCount(n: number) {
      roomCount = n;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildAdminApp(roomManager: any) {
  const app = Fastify();
  await app.register(createAdminRoutes(roomManager));
  await app.ready();
  return app;
}

function fakeWorkerManager(count = 1, expected = 1) {
  return {
    getWorkerCount: () => count,
    getExpectedWorkerCount: () => expected,
  };
}

async function buildHealthApp() {
  const app = Fastify();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(createHealthRoutes(fakeWorkerManager() as any));
  await app.ready();
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Admin drain/undrain routes", () => {
  beforeEach(() => {
    resetDrain();
  });

  afterEach(() => {
    resetDrain();
  });

  describe("auth (AC5)", () => {
    it("POST /admin/undrain with no key -> 401 Unauthorized", async () => {
      const app = await buildAdminApp(createMockRoomManager());
      const res = await app.inject({ method: "POST", url: "/admin/undrain" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ status: "error", message: "Unauthorized" });
      await app.close();
    });

    it("POST /admin/undrain with a wrong key -> 401", async () => {
      const app = await buildAdminApp(createMockRoomManager());
      const res = await app.inject({
        method: "POST",
        url: "/admin/undrain",
        headers: { "x-internal-key": "totally-wrong" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("POST /admin/drain with no key -> 401 (helper extraction didn't loosen it)", async () => {
      const app = await buildAdminApp(createMockRoomManager());
      const res = await app.inject({ method: "POST", url: "/admin/drain" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ status: "error", message: "Unauthorized" });
      await app.close();
    });

    it("GET /admin/status with no key -> 401 (helper extraction didn't loosen it)", async () => {
      const app = await buildAdminApp(createMockRoomManager());
      const res = await app.inject({ method: "GET", url: "/admin/status" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ status: "error", message: "Unauthorized" });
      await app.close();
    });

    it("POST /admin/undrain with a valid PREVIOUS key -> 200 (rotation works through the helper)", async () => {
      const app = await buildAdminApp(createMockRoomManager());
      const res = await app.inject({
        method: "POST",
        url: "/admin/undrain",
        headers: { "x-internal-key": PREVIOUS_KEY },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("drain idempotency (AC2)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("repeat POST /admin/drain returns 200 and does not restart the clock", async () => {
      const app = await buildAdminApp(createMockRoomManager(1));

      const res1 = await app.inject({
        method: "POST",
        url: "/admin/drain",
        headers: AUTH_HEADERS,
      });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.payload).draining).toBe(true);

      const status1 = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: AUTH_HEADERS,
      });
      const drainStartedAt1 = JSON.parse(status1.payload).drainStartedAt;
      expect(drainStartedAt1).not.toBeNull();

      // Advance the clock BETWEEN the two drain calls — if the repeat call
      // restarted the clock, drainStartedAt would shift by this amount.
      // Stays under the 5s poll interval so nothing completes in between.
      vi.advanceTimersByTime(1_000);

      const res2 = await app.inject({
        method: "POST",
        url: "/admin/drain",
        headers: AUTH_HEADERS,
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.payload).message).toBe("Already draining");

      const status2 = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: AUTH_HEADERS,
      });
      expect(JSON.parse(status2.payload).drainStartedAt).toBe(drainStartedAt1);

      await app.close();
    });

    it("repeat drain does not spawn a second timer set — undrain still fully cancels it", async () => {
      // If the repeat POST /admin/drain ever orphaned a second interval/timeout
      // (in addition to the one resetDrain() clears), that orphan would fire
      // on its own schedule and re-flip `drained` after undrain — resetDrain's
      // `if (drained) return` guard inside completeDrain reopens once
      // `drained` is back to false. This proves no such orphan exists.
      const app = await buildAdminApp(createMockRoomManager(5));

      await app.inject({ method: "POST", url: "/admin/drain?timeout=10", headers: AUTH_HEADERS });
      await app.inject({ method: "POST", url: "/admin/drain?timeout=10", headers: AUTH_HEADERS });
      await app.inject({ method: "POST", url: "/admin/undrain", headers: AUTH_HEADERS });

      vi.advanceTimersByTime(60_000);

      expect(isDrained()).toBe(false);
      expect(getDrainReport()).toBe(null);

      await app.close();
    });
  });

  describe("un-drain restores rotation (AC4)", () => {
    it("drain then undrain clears isDraining()/isDrained()", async () => {
      const app = await buildAdminApp(createMockRoomManager(1));

      await app.inject({ method: "POST", url: "/admin/drain", headers: AUTH_HEADERS });
      expect(isDraining()).toBe(true);

      const res = await app.inject({
        method: "POST",
        url: "/admin/undrain",
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      expect(isDraining()).toBe(false);
      expect(isDrained()).toBe(false);

      await app.close();
    });

    it("GET /admin/status after undrain reports draining:false, drained:false, drainOutcome:null", async () => {
      const app = await buildAdminApp(createMockRoomManager(1));

      await app.inject({ method: "POST", url: "/admin/drain", headers: AUTH_HEADERS });
      await app.inject({ method: "POST", url: "/admin/undrain", headers: AUTH_HEADERS });

      const res = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: AUTH_HEADERS,
      });
      const body = JSON.parse(res.payload);
      expect(body.draining).toBe(false);
      expect(body.drained).toBe(false);
      expect(body.drainOutcome).toBe(null);

      await app.close();
    });

    it("health check: 503 while draining, no longer status:draining after undrain", async () => {
      const adminApp = await buildAdminApp(createMockRoomManager(1));
      const healthApp = await buildHealthApp();

      await adminApp.inject({ method: "POST", url: "/admin/drain", headers: AUTH_HEADERS });

      const whileDraining = await healthApp.inject({ method: "GET", url: "/health" });
      expect(whileDraining.statusCode).toBe(503);
      expect(JSON.parse(whileDraining.payload).status).toBe("draining");

      await adminApp.inject({ method: "POST", url: "/admin/undrain", headers: AUTH_HEADERS });

      const afterUndrain = await healthApp.inject({ method: "GET", url: "/health" });
      // The NLB reads the status code, not the body — assert the code
      // directly rather than just "not draining" (which a 503 "degraded"
      // would also satisfy but would NOT mean rotation was restored).
      expect(afterUndrain.statusCode).toBe(200);
      expect(JSON.parse(afterUndrain.payload).status).not.toBe("draining");

      await adminApp.close();
      await healthApp.close();
    });
  });

  describe("un-drain idempotency (AC3)", () => {
    it("POST /admin/undrain twice in a row after a drain -> both 200, no throw", async () => {
      const app = await buildAdminApp(createMockRoomManager(1));

      await app.inject({ method: "POST", url: "/admin/drain", headers: AUTH_HEADERS });

      const res1 = await app.inject({
        method: "POST",
        url: "/admin/undrain",
        headers: AUTH_HEADERS,
      });
      const res2 = await app.inject({
        method: "POST",
        url: "/admin/undrain",
        headers: AUTH_HEADERS,
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      await app.close();
    });

    it("POST /admin/undrain on an instance that was NEVER drained -> 200, message 'Not draining'", async () => {
      const app = await buildAdminApp(createMockRoomManager(1));

      const res = await app.inject({
        method: "POST",
        url: "/admin/undrain",
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.message).toBe("Not draining");
      expect(body.draining).toBe(false);
      expect(body.drained).toBe(false);
      expect(body.drainOutcome).toBe(null);
      expect(body.roomsStillOpen).toBe(null);

      await app.close();
    });
  });

  describe("timer cancellation — the critical one", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("cancelled drain's ceiling timer never fires and cannot re-flip the instance to drained", async () => {
      // Rooms never close on their own — only the ceiling timer would flip
      // this instance to drained, if it were allowed to fire.
      const app = await buildAdminApp(createMockRoomManager(5));

      await app.inject({
        method: "POST",
        url: "/admin/drain?timeout=10",
        headers: AUTH_HEADERS,
      });
      await app.inject({ method: "POST", url: "/admin/undrain", headers: AUTH_HEADERS });

      vi.advanceTimersByTime(60_000);

      expect(isDrained()).toBe(false);
      expect(getDrainReport()).toBe(null);

      await app.close();
    });

    it("cancelled drain's 5s poll interval does not fire completeDrain either (0 rooms open)", async () => {
      const app = await buildAdminApp(createMockRoomManager(0));

      await app.inject({
        method: "POST",
        url: "/admin/drain?timeout=10",
        headers: AUTH_HEADERS,
      });
      await app.inject({ method: "POST", url: "/admin/undrain", headers: AUTH_HEADERS });

      vi.advanceTimersByTime(60_000);

      expect(isDrained()).toBe(false);
      expect(getDrainReport()).toBe(null);

      await app.close();
    });
  });

  describe("re-drain after un-drain (AC3 — un-drain leaves state usable, not just clean)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("drain -> undrain -> drain again still completes (undrain does not permanently disable drainability)", async () => {
      // The scenario the ticket exists for: a roll halts, the operator un-drains
      // to restore rotation, fixes the cause, then rolls again. Ticket 29's canary
      // rollout cycles drain repeatedly, so the SECOND drain must behave like the first.
      const app = await buildAdminApp(createMockRoomManager(5));

      await app.inject({ method: "POST", url: "/admin/drain?timeout=10", headers: AUTH_HEADERS });
      const first = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: AUTH_HEADERS,
      });
      const firstStartedAt = JSON.parse(first.payload).drainStartedAt;

      await app.inject({ method: "POST", url: "/admin/undrain", headers: AUTH_HEADERS });

      vi.advanceTimersByTime(1_000);

      const res = await app.inject({
        method: "POST",
        url: "/admin/drain?timeout=10",
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).draining).toBe(true);

      // A fresh clock, not a resurrected one.
      const second = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: AUTH_HEADERS,
      });
      expect(JSON.parse(second.payload).drainStartedAt).not.toBe(firstStartedAt);

      // The load-bearing assertion: completeDrain()'s `if (drained) return` guard
      // must have REOPENED after resetDrain(). If un-drain left `drained` latched,
      // this second drain would run forever and never report — a canary rollout
      // would hang on its second cycle with no error to show for it.
      vi.advanceTimersByTime(11_000);
      expect(isDrained()).toBe(true);
      expect(getDrainReport()?.outcome).toBe("timeout");
      expect(getDrainReport()?.roomsStillOpen).toBe(5);

      await app.close();
    });
  });
});
