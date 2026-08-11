import { describe, it, expect, beforeEach } from "vitest";
import {
  MixerPortRegistry,
  MixerPortsExhaustedError,
} from "@src/domains/broadcast/mixer-port-registry.js";
import { metrics } from "@src/infrastructure/metrics.js";

/**
 * ticket 32 pt.3: MixerPortRegistry had zero instrumentation. These gauges/
 * counter are the saturation signal for the shared UDP port pool that every
 * Room's broadcast mixer on an instance draws from.
 *
 * The underlying prom-client series are module-level singletons shared by
 * every `it()` in this file (and reused whenever this suite constructs
 * multiple `MixerPortRegistry` instances, mirroring production's "one
 * registry per instance" — but several per test here). Reset in `beforeEach`
 * and assert deltas rather than absolutes so cases don't depend on run order.
 */
describe("MixerPortRegistry metrics", () => {
  beforeEach(() => {
    metrics.hlsMixerPortsInUse.reset();
    metrics.hlsMixerPortsCapacity.reset();
    metrics.hlsMixerPortExhausted.reset();
  });

  const gaugeValue = async (gauge: { get(): Promise<{ values: { value: number }[] }> }) => {
    const { values } = await gauge.get();
    return values[0]?.value ?? 0;
  };

  it("sets capacity once, at construction, to the size of the allocatable range", async () => {
    // [5004, 5010) stepping by 2 (the registry's internal PORT_STEP) fits 3 ports.
    new MixerPortRegistry(5004, 5010);
    expect(await gaugeValue(metrics.hlsMixerPortsCapacity)).toBe(3);
  });

  it("rounds a non-multiple range up, so the last partial step still counts", async () => {
    // [5004, 5009) — 5004, 5006, 5008 are candidates; ceil((5009-5004)/2) = 3.
    new MixerPortRegistry(5004, 5009);
    expect(await gaugeValue(metrics.hlsMixerPortsCapacity)).toBe(3);
  });

  it("tracks ports_in_use across allocate() and release()", async () => {
    const registry = new MixerPortRegistry(5004, 5020);

    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(0);

    const a = registry.allocate();
    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(1);

    const b = registry.allocate();
    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(2);

    registry.release(a);
    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(1);

    registry.release(b);
    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(0);
  });

  it("increments port_exhausted_total exactly once when the pool runs out", async () => {
    // A tiny range that only fits one port: [5004, 5006).
    const registry = new MixerPortRegistry(5004, 5006);
    registry.allocate(); // takes the only port

    const before = await gaugeValue(metrics.hlsMixerPortExhausted);

    expect(() => registry.allocate()).toThrow(MixerPortsExhaustedError);

    const after = await gaugeValue(metrics.hlsMixerPortExhausted);
    expect(after - before).toBe(1);

    // A second exhaustion attempt increments again — the counter never stalls.
    expect(() => registry.allocate()).toThrow(MixerPortsExhaustedError);
    expect((await gaugeValue(metrics.hlsMixerPortExhausted)) - before).toBe(2);
  });

  it("does not increment ports_in_use when allocate() throws (no port was actually taken)", async () => {
    const registry = new MixerPortRegistry(5004, 5006);
    registry.allocate();
    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(1);

    expect(() => registry.allocate()).toThrow(MixerPortsExhaustedError);
    expect(await gaugeValue(metrics.hlsMixerPortsInUse)).toBe(1);
  });
});
