import { describe, it, expect, vi } from "vitest";
import { SpeakerMixer } from "@src/domains/broadcast/speaker-mixer.js";
import {
  MixerPortRegistry,
  MixerPortsExhaustedError,
} from "@src/domains/broadcast/mixer-port-registry.js";

/**
 * mediasoup is a native module the suite doesn't load (see worker.manager.test),
 * so SpeakerMixer is tested against a fake Router exposing exactly the surface it
 * touches: createPlainTransport → transport.connect/consume/close. This proves
 * the orchestration (diff, port alloc/reuse, SDP, lifecycle); the real consume
 * + real ffmpeg legs are covered by the ffmpeg integration test + device test.
 */
function makeConsumer(payloadType = 111) {
  return {
    rtpParameters: { codecs: [{ payloadType, clockRate: 48000, channels: 2 }] },
    resume: vi.fn(async () => {}),
  };
}

function makeFakeRouter() {
  const connects: { ip: string; port: number }[] = [];
  const transports: any[] = [];
  const router = {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createPlainTransport: vi.fn(async () => {
      const consumer = makeConsumer();
      const transport: any = {
        closed: false,
        connect: vi.fn(async (opts: { ip: string; port: number }) => {
          connects.push(opts);
        }),
        consume: vi.fn(async () => consumer),
        close: vi.fn(function (this: any) {
          this.closed = true;
        }),
        _consumer: consumer,
      };
      transports.push(transport);
      return transport;
    }),
  };
  return { router, connects, transports };
}

const logger = { warn() {}, debug() {}, info() {}, error() {} } as any;

describe("SpeakerMixer.sync", () => {
  it("adds a transport+consumer per producer and reports the set changed", async () => {
    const { router, connects } = makeFakeRouter();
    const mixer = new SpeakerMixer(router as any, logger, new MixerPortRegistry());

    const changed = await mixer.sync(["p1", "p2"]);

    expect(changed).toBe(true);
    expect(mixer.size).toBe(2);
    expect(router.createPlainTransport).toHaveBeenCalledTimes(2);
    // Distinct, even, ascending ports from the base (5004, 5006).
    expect(connects.map((c) => c.port)).toEqual([5004, 5006]);
    expect(connects.every((c) => c.ip === "127.0.0.1")).toBe(true);
  });

  it("is a no-op (changed=false) when the set is unchanged", async () => {
    const { router } = makeFakeRouter();
    const mixer = new SpeakerMixer(router as any, logger, new MixerPortRegistry());
    await mixer.sync(["p1", "p2"]);
    router.createPlainTransport.mockClear();

    const changed = await mixer.sync(["p2", "p1"]);

    expect(changed).toBe(false);
    expect(router.createPlainTransport).not.toHaveBeenCalled();
    expect(mixer.size).toBe(2);
  });

  it("removes departed producers, closes their transport, and frees the port", async () => {
    const { router, transports, connects } = makeFakeRouter();
    const mixer = new SpeakerMixer(router as any, logger, new MixerPortRegistry());
    await mixer.sync(["p1", "p2"]);

    const changed = await mixer.sync(["p1"]);

    expect(changed).toBe(true);
    expect(mixer.size).toBe(1);
    // p2's transport (the 2nd created) is closed.
    expect(transports[1].close).toHaveBeenCalled();

    // A new producer reuses the freed port (5006), not a fresh higher one.
    await mixer.sync(["p1", "p3"]);
    expect(connects.map((c) => c.port)).toEqual([5004, 5006, 5006]);
  });
});

describe("SpeakerMixer SDP + inputs", () => {
  it("maps consumer rtpParameters to mix inputs in stable order", async () => {
    const { router } = makeFakeRouter();
    const mixer = new SpeakerMixer(router as any, logger, new MixerPortRegistry());
    await mixer.sync(["p1", "p2"]);

    const inputs = mixer.getInputs();
    expect(inputs).toEqual([
      { port: 5004, payloadType: 111, clockRate: 48000, channels: 2 },
      { port: 5006, payloadType: 111, clockRate: 48000, channels: 2 },
    ]);

    const sdp = mixer.getSdp();
    expect(sdp).toContain("m=audio 5004 RTP/AVP 111");
    expect(sdp).toContain("m=audio 5006 RTP/AVP 111");
  });
});

describe("SpeakerMixer lifecycle", () => {
  it("resumeAll resumes every consumer", async () => {
    const { router, transports } = makeFakeRouter();
    const mixer = new SpeakerMixer(router as any, logger, new MixerPortRegistry());
    await mixer.sync(["p1", "p2"]);

    await mixer.resumeAll();

    expect(transports[0]._consumer.resume).toHaveBeenCalled();
    expect(transports[1]._consumer.resume).toHaveBeenCalled();
  });

  it("close() closes all transports and empties the mix", async () => {
    const { router, transports } = makeFakeRouter();
    const mixer = new SpeakerMixer(router as any, logger, new MixerPortRegistry());
    await mixer.sync(["p1", "p2"]);

    mixer.close();

    expect(mixer.size).toBe(0);
    expect(transports.every((t) => t.close.mock.calls.length > 0)).toBe(true);
  });
});

describe("MixerPortRegistry — instance-scoped sharing across Rooms", () => {
  it("two concurrent Rooms' mixers on one instance allocate distinct ports (no collision)", async () => {
    const registry = new MixerPortRegistry();
    const roomA = makeFakeRouter();
    const roomB = makeFakeRouter();
    const mixerA = new SpeakerMixer(roomA.router as any, logger, registry);
    const mixerB = new SpeakerMixer(roomB.router as any, logger, registry);

    await mixerA.sync(["a1"]);
    await mixerB.sync(["b1"]);

    // Room B's mixer must NOT start back at the base port — it shares the
    // registry with Room A's mixer, so both broadcasts get distinct ports.
    expect(roomA.connects.map((c) => c.port)).toEqual([5004]);
    expect(roomB.connects.map((c) => c.port)).toEqual([5006]);
  });

  it("releases a port on Room teardown and a different Room's mixer can reallocate it", async () => {
    const registry = new MixerPortRegistry();
    const roomA = makeFakeRouter();
    const roomB = makeFakeRouter();
    const mixerA = new SpeakerMixer(roomA.router as any, logger, registry);
    const mixerB = new SpeakerMixer(roomB.router as any, logger, registry);

    await mixerA.sync(["a1"]); // takes 5004
    await mixerB.sync(["b1"]); // takes 5006

    mixerA.close(); // Room A's broadcast ends, frees 5004

    await mixerB.sync(["b1", "b2"]); // Room B grows — reuses the freed 5004
    expect(roomB.connects.map((c) => c.port)).toEqual([5006, 5004]);
  });

  it("throws loudly (does not silently fail) when the port range is exhausted", async () => {
    // A tiny range that only fits one port: [5004, 5006).
    const registry = new MixerPortRegistry(5004, 5006);
    const room = makeFakeRouter();
    const mixer = new SpeakerMixer(room.router as any, logger, registry);

    await mixer.sync(["p1"]); // takes the only port, 5004

    await expect(mixer.sync(["p1", "p2"])).rejects.toThrow(MixerPortsExhaustedError);
  });

  it("stays clear of the mediasoup WebRTC port range by default", () => {
    // MEDIASOUP_RTC_MIN_PORT defaults to 10000 — the pool's default upper
    // bound must never reach it.
    const registry = new MixerPortRegistry();
    let lastPort = -1;
    for (let i = 0; i < 5; i++) lastPort = registry.allocate();
    expect(lastPort).toBeLessThan(10000);
  });
});
