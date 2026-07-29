import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { pino } from "pino";
import {
  correlationMixin,
  currentCorrelationId,
  resolveCorrelationId,
  withCorrelation,
} from "@src/infrastructure/correlation.js";

/**
 * Build a logger wired with the real `correlationMixin`, writing to memory.
 *
 * The production logger is constructed at import time against the real config and writes to its
 * own file descriptor, so it cannot be pointed at a test stream. This drives the SAME mixin
 * function through a local instance; a separate test asserts the real logger is configured with
 * that exact function.
 */
function makeLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });

  const logger = pino({ level: "debug", mixin: correlationMixin }, stream);

  return {
    logger,
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("ambient correlation context", () => {
  it("puts the identifier on a log line whose call site never mentions it", () => {
    const { logger, lines } = makeLogger();

    withCorrelation("inbound-abc-123", () => {
      // Deliberately no correlation field here. That is the whole point of the ticket.
      logger.info({ event: "seat:take" }, "Handler completed");
    });

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      correlationId: "inbound-abc-123",
      event: "seat:take",
    });
  });

  it("leaves log lines written outside any correlated operation unchanged", () => {
    const { logger, lines } = makeLogger();

    logger.info({ phase: "startup" }, "Server listening");

    // Startup and timer lines have no operation to belong to. Stamping a minted identifier on them
    // would imply a join that does not exist.
    expect(lines()[0]).not.toHaveProperty("correlationId");
  });

  it("keeps the identifier across await points inside one operation", async () => {
    const seen: (string | undefined)[] = [];

    await withCorrelation("stable-id", async () => {
      seen.push(currentCorrelationId());
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentCorrelationId());
    });

    expect(seen).toEqual(["stable-id", "stable-id"]);
  });

  it("does not leak the identifier between concurrent interleaved operations", async () => {
    const observed: Record<string, (string | undefined)[]> = { a: [], b: [] };

    // This is the failure mode a module-level variable would have: B starts while A is awaiting,
    // and A's remaining log lines would be attributed to B. Under load that is most log lines.
    await Promise.all([
      withCorrelation("id-a", async () => {
        observed.a.push(currentCorrelationId());
        await new Promise((resolve) => setTimeout(resolve, 20));
        observed.a.push(currentCorrelationId());
      }),
      withCorrelation("id-b", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.b.push(currentCorrelationId());
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.b.push(currentCorrelationId());
      }),
    ]);

    expect(observed.a).toEqual(["id-a", "id-a"]);
    expect(observed.b).toEqual(["id-b", "id-b"]);
  });

  it("returns undefined once the operation has finished", async () => {
    await withCorrelation("scoped", async () => {
      expect(currentCorrelationId()).toBe("scoped");
    });

    expect(currentCorrelationId()).toBeUndefined();
  });

  it("adopts a usable inbound identifier", () => {
    expect(resolveCorrelationId("9f8e7d6c5b4a3210")).toBe("9f8e7d6c5b4a3210");
    expect(resolveCorrelationId("req_68.abc:1-2")).toBe("req_68.abc:1-2");
  });

  it("mints when no inbound identifier is supplied", () => {
    const minted = resolveCorrelationId(undefined);

    expect(minted).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats the ingest schema's 'unknown' default as absent", () => {
    // event-ingest's Zod schema defaults correlation_id to the literal "unknown". Adopting it would
    // stamp the same meaningless value across every unrelated Laravel event.
    const resolved = resolveCorrelationId("unknown");

    expect(resolved).not.toBe("unknown");
    expect(resolved).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([
    ["over-long", "a".repeat(129)],
    ["newline injection", "abc\ninjected=1"],
    ["whitespace only", "   "],
    ["unsafe characters", "<script>alert(1)</script>"],
    ["empty", ""],
  ])("rejects an unusable inbound identifier (%s)", (_label, inbound) => {
    const resolved = resolveCorrelationId(inbound);

    expect(resolved).not.toBe(inbound);
    expect(resolved).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is the exact mixin the real logger is configured with", async () => {
    const loggerModule = await import("@src/infrastructure/logger.js");

    // The tests above drive `correlationMixin` through a locally-built Pino instance. That would
    // keep passing if someone removed the mixin from the real logger, so assert the wiring itself:
    // the logger's configured mixin must be this exact function, not a copy.
    expect(loggerModule.logger[pino.symbols.mixinSym]).toBe(correlationMixin);
  });

  it("lets an explicit correlationId on the log object win over the ambient one", () => {
    const { logger, lines } = makeLogger();

    // The relay path logs the SENDER's identifier explicitly. Pino merges the log object over the
    // mixin, so that must keep working rather than being silently overwritten.
    withCorrelation("ambient-id", () => {
      logger.info({ correlationId: "sender-id" }, "Routing event");
    });

    expect(lines()[0]).toMatchObject({ correlationId: "sender-id" });
  });
});
