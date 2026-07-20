import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/node";
import { scrubSecrets } from "@src/infrastructure/sentry/scrub.js";

function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    message: "something went wrong",
    ...overrides,
  };
}

describe("scrubSecrets", () => {
  it("redacts a JWT-shaped substring nested in a string", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const event = makeEvent({
      extra: { note: `Authorization failed with token ${jwt} for user 5` },
    });

    const result = scrubSecrets(event, []);

    expect(result.extra?.note).toBe("[Filtered]");
  });

  it("redacts a known secret value passed via the secrets argument", () => {
    const secret = "super-secret-value-123";
    const event = makeEvent({
      extra: { detail: `db connection failed, password=${secret}` },
    });

    const result = scrubSecrets(event, [secret]);

    expect(result.extra?.detail).toBe("[Filtered]");
  });

  it("ignores a secret shorter than 8 characters (does not over-redact)", () => {
    const event = makeEvent({
      extra: { detail: "the value abc123 appeared in a log line" },
    });

    const result = scrubSecrets(event, ["abc123"]); // 6 chars, below the 8-char floor

    expect(result.extra?.detail).toBe(
      "the value abc123 appeared in a log line",
    );
  });

  it("redacts by key name: authorization", () => {
    const event = makeEvent({
      tags: { authorization: "Bearer some-plain-value" },
    });

    const result = scrubSecrets(event, []);

    expect(result.tags?.authorization).toBe("[Filtered]");
  });

  it("redacts by key name: password", () => {
    const event = makeEvent({
      extra: { password: "hunter2" },
    });

    const result = scrubSecrets(event, []);

    expect(result.extra?.password).toBe("[Filtered]");
  });

  it("redacts by key name: apiKey (case-insensitive, camelCase)", () => {
    const event = makeEvent({
      extra: { apiKey: "plain-looking-value" },
    });

    const result = scrubSecrets(event, []);

    expect(result.extra?.apiKey).toBe("[Filtered]");
  });

  it("does not hang on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { name: "room-42" };
    cyclic.self = cyclic;

    const event = makeEvent({ extra: { cyclic } });

    const result = scrubSecrets(event, []);

    expect(result).toBe(event);
    expect((result.extra?.cyclic as Record<string, unknown>).name).toBe(
      "room-42",
    );
  });

  it("leaves a plain innocuous string untouched", () => {
    const event = makeEvent({
      extra: { note: "user joined room 42 as a listener" },
    });

    const result = scrubSecrets(event, ["some-other-secret-value"]);

    expect(result.extra?.note).toBe("user joined room 42 as a listener");
  });

  it("leaves numbers and booleans untouched", () => {
    const event = makeEvent({
      extra: { count: 42, active: true, ratio: 0 },
    });

    const result = scrubSecrets(event, []);

    expect(result.extra?.count).toBe(42);
    expect(result.extra?.active).toBe(true);
    expect(result.extra?.ratio).toBe(0);
  });

  it("never throws, even on a malformed event", () => {
    const weird = { type: undefined, extra: null } as ErrorEvent;

    expect(() => scrubSecrets(weird, [])).not.toThrow();
  });
});
