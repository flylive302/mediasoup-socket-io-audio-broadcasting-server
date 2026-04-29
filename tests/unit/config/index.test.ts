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

  it("passes in production with cascade disabled and INSTANCE_ID resolved", async () => {
    process.env.NODE_ENV = "production";
    process.env.CASCADE_ENABLED = "false";
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
});
