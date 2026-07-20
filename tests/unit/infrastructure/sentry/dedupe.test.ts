import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { seenRecently, __resetDedupe } from "@src/infrastructure/sentry/dedupe.js";

describe("seenRecently", () => {
  beforeEach(() => {
    __resetDedupe();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the first occurrence of a key through", () => {
    expect(seenRecently("a")).toBe(false);
  });

  it("suppresses a repeat inside the window", () => {
    expect(seenRecently("a")).toBe(false);
    expect(seenRecently("a")).toBe(true);
    expect(seenRecently("a")).toBe(true);
  });

  it("keeps distinct keys independent", () => {
    expect(seenRecently("a")).toBe(false);
    expect(seenRecently("b")).toBe(false);
  });

  it("lets the key through again once the window elapses", () => {
    expect(seenRecently("a")).toBe(false);
    vi.advanceTimersByTime(59_000);
    expect(seenRecently("a")).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(seenRecently("a")).toBe(false);
  });

  it("treats keys differing only past 300 chars as the same key", () => {
    const base = "x".repeat(300);
    expect(seenRecently(base + "AAA")).toBe(false);
    expect(seenRecently(base + "BBB")).toBe(true);
  });

  it("stays bounded: clearing at the cap lets an old key report again", () => {
    expect(seenRecently("first")).toBe(false);
    expect(seenRecently("first")).toBe(true);

    // Overflow the 500-key ceiling, which drops the whole map.
    for (let i = 0; i < 600; i++) seenRecently(`filler-${i}`);

    expect(seenRecently("first")).toBe(false);
  });
});
