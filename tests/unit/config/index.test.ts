/**
 * Config production-mode startup assertions.
 *
 * Each test sets the env, then `vi.resetModules()` and dynamic-imports the
 * config module so Zod re-parses with the new env. INSTANCE_ID_OVERRIDE
 * sidesteps IMDSv2 in unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_ENV = {
  JWT_SECRET: "x".repeat(32),
  LARAVEL_API_URL: "https://example.test",
  LARAVEL_INTERNAL_KEY: "y".repeat(32),
  // F-16: production now requires TURN keys; set them by default so the other
  // production assertions can be exercised in isolation.
  CLOUDFLARE_TURN_API_KEY: "t".repeat(32),
  CLOUDFLARE_TURN_KEY_ID: "k".repeat(16),
};

describe("config assertions", () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env = { ...REQUIRED_ENV } as NodeJS.ProcessEnv;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("passes in development with no cascade vars", async () => {
    process.env.NODE_ENV = "development";
    process.env.INSTANCE_ID_OVERRIDE = "dev-host";

    const { config, initializeConfig } = await import("@src/config/index.js");
    await initializeConfig();
    expect(config.INSTANCE_ID).toBe("dev-host");
  });

  it("passes in production with cascade disabled, affinity attested, and INSTANCE_ID resolved", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "false";
    // aws-app-affinity/12: cascade off now requires an affinity attestation
    // (the reverse boot assertion) — this test previously passed with no
    // affinity var set at all, which is exactly the unguarded direction the
    // ticket closes. Updated deliberately, not a silently moved goalpost.
    process.env.AFFINITY_ENABLED = "true";
    process.env.INSTANCE_ID_OVERRIDE = "i-prod-1";

    const { config, initializeConfig } = await import("@src/config/index.js");
    await initializeConfig();
    expect(config.INSTANCE_ID).toBe("i-prod-1");
  });

  it("passes in production with cascade enabled and all required vars set", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "true";
    process.env.INTERNAL_API_KEY = "z".repeat(32);
    process.env.PUBLIC_IP = "1.2.3.4";
    process.env.INSTANCE_ID_OVERRIDE = "i-prod-2";

    const { initializeConfig } = await import("@src/config/index.js");
    await expect(initializeConfig()).resolves.not.toThrow();
  });

  it("throws in production when cascade enabled but INTERNAL_API_KEY is missing", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "true";
    process.env.INTERNAL_API_KEY = "";
    process.env.PUBLIC_IP = "1.2.3.4";
    process.env.INSTANCE_ID_OVERRIDE = "i-prod-3";

    const { initializeConfig } = await import("@src/config/index.js");
    await expect(initializeConfig()).rejects.toThrow(/INTERNAL_API_KEY/);
  });

  it("throws in production when cascade enabled but PUBLIC_IP is empty", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "true";
    process.env.INTERNAL_API_KEY = "z".repeat(32);
    process.env.PUBLIC_IP = "";
    process.env.INSTANCE_ID_OVERRIDE = "i-prod-4";

    const { initializeConfig } = await import("@src/config/index.js");
    await expect(initializeConfig()).rejects.toThrow(/PUBLIC_IP/);
  });

  // aws-app-affinity/12: the full flag x flag matrix. Both assertions are of
  // the form "flag is on the dangerous side AND its prerequisite is missing
  // → throw" — cascade-on guards its own secrets, cascade-off guards on
  // affinity. Neither must fire in a valid configuration, and cascade-off
  // must not resurrect the cascade-on secret requirements (symmetry).
  describe("cascade x affinity matrix", () => {
    it("cascade on, affinity on: passes (cascade's own prerequisites still required)", async () => {
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "true";
      process.env.AFFINITY_ENABLED = "true";
      process.env.INTERNAL_API_KEY = "z".repeat(32);
      process.env.PUBLIC_IP = "1.2.3.4";
      process.env.INSTANCE_ID_OVERRIDE = "i-matrix-on-on";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).resolves.not.toThrow();
    });

    it("cascade on, affinity off: passes (affinity is irrelevant while cascade covers routing)", async () => {
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "true";
      process.env.AFFINITY_ENABLED = "false";
      process.env.INTERNAL_API_KEY = "z".repeat(32);
      process.env.PUBLIC_IP = "1.2.3.4";
      process.env.INSTANCE_ID_OVERRIDE = "i-matrix-on-off";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).resolves.not.toThrow();
    });

    it("cascade off, affinity on: passes WITHOUT INTERNAL_API_KEY or PUBLIC_IP (symmetry)", async () => {
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "false";
      process.env.AFFINITY_ENABLED = "true";
      process.env.INTERNAL_API_KEY = "";
      process.env.PUBLIC_IP = "";
      process.env.INSTANCE_ID_OVERRIDE = "i-matrix-off-on";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).resolves.not.toThrow();
    });

    it("cascade off, affinity off: throws naming both flags", async () => {
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "false";
      process.env.AFFINITY_ENABLED = "false";
      process.env.INSTANCE_ID_OVERRIDE = "i-matrix-off-off";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).rejects.toThrow(
        /CASCADE_ENABLED=false requires AFFINITY_ENABLED=true/,
      );
    });
  });

  it("throws in production when TURN keys are missing (F-16)", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "false";
    process.env.INSTANCE_ID_OVERRIDE = "i-prod-turn";
    delete process.env.CLOUDFLARE_TURN_API_KEY;
    delete process.env.CLOUDFLARE_TURN_KEY_ID;

    const { initializeConfig } = await import("@src/config/index.js");
    await expect(initializeConfig()).rejects.toThrow(/CLOUDFLARE_TURN/);
  });

  it("throws in production when INSTANCE_ID resolves to 'unknown'", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "false";
    process.env.INSTANCE_ID_OVERRIDE = "unknown";

    const { initializeConfig } = await import("@src/config/index.js");
    await expect(initializeConfig()).rejects.toThrow(/INSTANCE_ID/);
  });

  it("does NOT throw in development even when cascade vars are missing", async () => {
    process.env.NODE_ENV = "development";
    process.env.CASCADE_ENABLED = "true";
    process.env.INTERNAL_API_KEY = "";
    process.env.PUBLIC_IP = "";
    process.env.INSTANCE_ID_OVERRIDE = "dev";

    const { initializeConfig } = await import("@src/config/index.js");
    await expect(initializeConfig()).resolves.not.toThrow();
  });

  // 02-derive-worker-count-and-assert-vcpu-floor
  describe("MEDIASOUP_NUM_WORKERS derivation + vCPU floor", () => {
    it.each([
      [3, 2],
      [4, 3],
      [8, 7],
      [16, 15],
    ])("derives vCPU - 1 workers (%i vCPU -> %i workers) when unset", async (vcpuCount, expectedWorkers) => {
      vi.doMock("os", async (importOriginal) => {
        const actual = await importOriginal<typeof import("os")>();
        return {
          ...actual,
          cpus: () => Array.from({ length: vcpuCount }, () => ({}) as never),
        };
      });
      delete process.env.MEDIASOUP_NUM_WORKERS;
      process.env.NODE_ENV = "development";
      process.env.INSTANCE_ID_OVERRIDE = "dev-derive";

      const { config } = await import("@src/config/index.js");
      expect(config.MEDIASOUP_NUM_WORKERS).toBe(expectedWorkers);

      vi.doUnmock("os");
    });

    it("an explicit MEDIASOUP_NUM_WORKERS overrides the derivation", async () => {
      vi.doMock("os", async (importOriginal) => {
        const actual = await importOriginal<typeof import("os")>();
        return {
          ...actual,
          cpus: () => Array.from({ length: 16 }, () => ({}) as never),
        };
      });
      process.env.MEDIASOUP_NUM_WORKERS = "5";
      process.env.NODE_ENV = "development";
      process.env.INSTANCE_ID_OVERRIDE = "dev-override";

      const { config } = await import("@src/config/index.js");
      expect(config.MEDIASOUP_NUM_WORKERS).toBe(5);

      vi.doUnmock("os");
    });

    it("fails to boot in production below the vCPU floor (derived)", async () => {
      vi.doMock("os", async (importOriginal) => {
        const actual = await importOriginal<typeof import("os")>();
        return {
          ...actual,
          cpus: () => Array.from({ length: 2 }, () => ({}) as never), // 2 vCPU -> 1 worker, below the floor
        };
      });
      delete process.env.MEDIASOUP_NUM_WORKERS;
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "false";
      process.env.AFFINITY_ENABLED = "true"; // isolate the vCPU-floor assertion from aws-app-affinity/12's reverse check
      process.env.INSTANCE_ID_OVERRIDE = "i-prod-lowcpu";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).rejects.toThrow(/MEDIASOUP_NUM_WORKERS/);

      vi.doUnmock("os");
    });

    it("fails to boot in production when an explicit override is itself below the floor", async () => {
      process.env.MEDIASOUP_NUM_WORKERS = "1";
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "false";
      process.env.AFFINITY_ENABLED = "true"; // isolate the vCPU-floor assertion from aws-app-affinity/12's reverse check
      process.env.INSTANCE_ID_OVERRIDE = "i-prod-lowworkers";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).rejects.toThrow(/MEDIASOUP_NUM_WORKERS/);
    });

    it("passes in production at exactly the floor (3 vCPU -> 2 workers)", async () => {
      vi.doMock("os", async (importOriginal) => {
        const actual = await importOriginal<typeof import("os")>();
        return {
          ...actual,
          cpus: () => Array.from({ length: 3 }, () => ({}) as never),
        };
      });
      delete process.env.MEDIASOUP_NUM_WORKERS;
      process.env.NODE_ENV = "production";
      process.env.CASCADE_ENABLED = "false";
      process.env.AFFINITY_ENABLED = "true"; // isolate the vCPU-floor assertion from aws-app-affinity/12's reverse check
      process.env.INSTANCE_ID_OVERRIDE = "i-prod-floor";

      const { initializeConfig } = await import("@src/config/index.js");
      await expect(initializeConfig()).resolves.not.toThrow();

      vi.doUnmock("os");
    });
  });

  // platform-security 06: pin the PARSED default value of the auth-gate
  // fail-policy flags directly against the Zod schema — not just via a
  // downstream gate's behavior — so "defaults reproduce today's fail-OPEN
  // production behavior exactly" is a regression-guarded fact, not an
  // inference. Both flags share `booleanEnvSchemaDefaultTrue`, which (unlike
  // the plain `booleanEnvSchema` used by RATE_LIMIT_FAIL_OPEN) must treat an
  // explicit-but-EMPTY env value the same as unset — a templated cloud-init
  // file or blank `.env` line produces `""`, not `undefined`, and `""`
  // bypasses Zod's `.default()` entirely.
  describe("auth-gate fail-policy defaults (platform-security 06)", () => {
    it.each([
      ["JWT_REVOCATION_FAIL_OPEN"],
      ["ROOM_BLOCK_FAIL_OPEN"],
    ] as const)("%s: unset env resolves to true (fail-open)", async (key) => {
      delete process.env[key];

      const { config } = await import("@src/config/index.js");
      expect(config[key]).toBe(true);
    });

    it.each([
      ["JWT_REVOCATION_FAIL_OPEN"],
      ["ROOM_BLOCK_FAIL_OPEN"],
    ] as const)(
      "%s: explicit empty string still resolves to true (fail-open) — the bug this schema exists to avoid",
      async (key) => {
        process.env[key] = "";

        const { config } = await import("@src/config/index.js");
        expect(config[key]).toBe(true);
      },
    );

    it.each([
      ["JWT_REVOCATION_FAIL_OPEN"],
      ["ROOM_BLOCK_FAIL_OPEN"],
    ] as const)("%s: 'true'/'1' resolve to true", async (key) => {
      process.env[key] = "true";
      const trueResult = await import("@src/config/index.js");
      expect(trueResult.config[key]).toBe(true);

      vi.resetModules();
      process.env[key] = "1";
      const oneResult = await import("@src/config/index.js");
      expect(oneResult.config[key]).toBe(true);
    });

    it.each([
      ["JWT_REVOCATION_FAIL_OPEN"],
      ["ROOM_BLOCK_FAIL_OPEN"],
    ] as const)(
      "%s: only explicit 'false'/'0' resolve to false (fail-closed)",
      async (key) => {
        process.env[key] = "false";
        const falseResult = await import("@src/config/index.js");
        expect(falseResult.config[key]).toBe(false);

        vi.resetModules();
        process.env[key] = "0";
        const zeroResult = await import("@src/config/index.js");
        expect(zeroResult.config[key]).toBe(false);
      },
    );

    it.each([
      ["JWT_REVOCATION_FAIL_OPEN"],
      ["ROOM_BLOCK_FAIL_OPEN"],
    ] as const)("%s: an unrecognized value fails startup", async (key) => {
      process.env[key] = "yes";

      await expect(import("@src/config/index.js")).rejects.toThrow();
    });
  });
});
