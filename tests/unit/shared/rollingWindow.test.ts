import { describe, it, expect } from "vitest";
import { RollingWindow } from "@src/shared/rollingWindow.js";

const SECOND = 1000;
const BASE = 1_700_000_000_000; // arbitrary fixed epoch, second-aligned

describe("RollingWindow", () => {
  it("counts a single event within the window", () => {
    const w = new RollingWindow();
    w.record(BASE);
    expect(w.countLast(60 * SECOND, BASE)).toBe(1);
  });

  it("counts multiple events in the same second as one bucket", () => {
    const w = new RollingWindow();
    w.record(BASE);
    w.record(BASE + 100);
    w.record(BASE + 900);
    expect(w.countLast(60 * SECOND, BASE + 900)).toBe(3);
  });

  it("ages events out once they fall outside the window", () => {
    const w = new RollingWindow();
    w.record(BASE);
    // Just inside a 10s window at +9.9s
    expect(w.countLast(10 * SECOND, BASE + 9_900)).toBe(1);
    // Outside a 10s window at +10.1s (event is now >10s behind `now`)
    expect(w.countLast(10 * SECOND, BASE + 10_100)).toBe(0);
  });

  it("respects the exact boundary: an event windowMs old just falls out of range", () => {
    const w = new RollingWindow();
    w.record(BASE);
    // cutoff = nowSlot - windowSlots + 1, so an event exactly windowMs
    // behind `now` sits one slot before cutoff — out of range.
    expect(w.countLast(10 * SECOND, BASE + 10 * SECOND)).toBe(0);
    // One second later still, it's further out of range.
    expect(w.countLast(10 * SECOND, BASE + 10 * SECOND + SECOND)).toBe(0);
    // Just inside: windowMs minus one second behind `now`.
    expect(w.countLast(10 * SECOND, BASE + 9 * SECOND)).toBe(1);
  });

  it("never grows past maxSlots buckets after more than maxSlots seconds of records", () => {
    const maxSlots = 60;
    const w = new RollingWindow(maxSlots);
    for (let i = 0; i < maxSlots + 20; i++) {
      w.record(BASE + i * SECOND);
    }
    // Internal bucket map is private; assert indirectly via countLast over a
    // window far larger than maxSlots — anything older than maxSlots seconds
    // behind the latest record must already be evicted, so the count must be
    // capped at maxSlots (one event per second, one bucket per second).
    const latest = BASE + (maxSlots + 19) * SECOND;
    expect(w.countLast(10_000 * SECOND, latest)).toBe(maxSlots);
  });

  it("evicts old slots relative to the newest recorded event, not wall-clock polling", () => {
    const w = new RollingWindow(5);
    w.record(BASE);
    w.record(BASE + 1 * SECOND);
    w.record(BASE + 2 * SECOND);
    // Jump far ahead in one record — old slots must be evicted immediately,
    // not linger until a future countLast() call happens to poll them.
    w.record(BASE + 100 * SECOND);
    expect(w.countLast(10_000 * SECOND, BASE + 100 * SECOND)).toBe(1);
  });

  it("returns 0 for a window with no recorded events", () => {
    const w = new RollingWindow();
    expect(w.countLast(60 * SECOND, BASE)).toBe(0);
  });
});
