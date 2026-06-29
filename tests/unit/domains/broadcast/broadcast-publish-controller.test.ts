import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BroadcastPublishController,
  type BroadcastControllerDeps,
  type ClusterView,
  type MixerLike,
  type PublisherLike,
} from "@src/domains/broadcast/broadcast-publish-controller.js";

/** A fake mixer whose `sync` reports "changed" when the id set differs. */
function makeMixer(): MixerLike & { ids: string[] } {
  const state = { ids: [] as string[] };
  return {
    ids: state.ids,
    get size() {
      return state.ids.length;
    },
    sync: vi.fn(async (producerIds: string[]) => {
      const same =
        producerIds.length === state.ids.length &&
        producerIds.every((id) => state.ids.includes(id));
      state.ids.length = 0;
      state.ids.push(...producerIds);
      return !same;
    }),
    getSdp: vi.fn(() => "sdp"),
    resumeAll: vi.fn(async () => {}),
    close: vi.fn(),
  };
}

function makePublisher(): PublisherLike {
  return {
    start: vi.fn(async () => {}),
    restart: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

type FakeProducer = { producerId: string; kind?: string; paused?: boolean };

/**
 * Cluster over a MUTABLE producer list — push/splice the returned array to model
 * speakers joining/leaving; both getSourceProducers and getProducer read it, so
 * they stay consistent (a producer in the list is always resolvable).
 */
function makeCluster(producers: FakeProducer[]): ClusterView & { producers: FakeProducer[] } {
  return {
    producers,
    router: {},
    getSourceProducers: () =>
      producers.map((p) => ({
        producerId: p.producerId,
        userId: 1,
        kind: p.kind ?? "audio",
      })),
    getProducer: (id) => {
      const p = producers.find((x) => x.producerId === id);
      return p ? { paused: p.paused ?? false } : undefined;
    },
  };
}

/** Build a controller + its injected fakes, awaiting the per-room op chain. */
function setup(cluster: ClusterView, enabled = true) {
  const mixer = makeMixer();
  const publisher = makePublisher();
  const deps: BroadcastControllerDeps = {
    enabled,
    startupGraceMs: 0,
    getCluster: () => cluster,
    createMixer: () => mixer,
    createPublisher: () => publisher,
    logger: { warn() {}, error() {}, info() {}, debug() {} } as any,
  };
  const controller = new BroadcastPublishController(deps);
  // The controller serialises ops on an internal promise chain; flush microtasks.
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { controller, mixer, publisher, flush };
}

describe("BroadcastPublishController promote/demote", () => {
  it("on promote: syncs the mix, starts the publisher, then resumes consumers", async () => {
    const { controller, mixer, publisher, flush } = setup(
      makeCluster([{ producerId: "a" }, { producerId: "b" }]),
    );

    controller.onModeTransition("room1", "promote");
    await flush();

    expect(mixer.sync).toHaveBeenCalledWith(["a", "b"]);
    expect(publisher.start).toHaveBeenCalledWith("sdp", 2);
    expect(mixer.resumeAll).toHaveBeenCalled();
    expect(controller.isBroadcasting("room1")).toBe(true);

    // start must precede resumeAll (consumers resume only after ffmpeg binds).
    const startOrder = (publisher.start as any).mock.invocationCallOrder[0];
    const resumeOrder = (mixer.resumeAll as any).mock.invocationCallOrder[0];
    expect(startOrder).toBeLessThan(resumeOrder);
  });

  it("excludes PAUSED producers from the mix (would freeze amix)", async () => {
    const { controller, mixer, flush } = setup(
      makeCluster([
        { producerId: "a" },
        { producerId: "muted", paused: true },
        { producerId: "video", kind: "video" },
      ]),
    );

    controller.onModeTransition("room1", "promote");
    await flush();

    // Only the live audio producer is mixed.
    expect(mixer.sync).toHaveBeenCalledWith(["a"]);
  });

  it("on demote: closes the mixer and stops the publisher", async () => {
    const { controller, mixer, publisher, flush } = setup(
      makeCluster([{ producerId: "a" }]),
    );
    controller.onModeTransition("room1", "promote");
    await flush();

    controller.onModeTransition("room1", "demote");
    await flush();

    expect(mixer.close).toHaveBeenCalled();
    expect(publisher.stop).toHaveBeenCalled();
    expect(controller.isBroadcasting("room1")).toBe(false);
  });
});

describe("BroadcastPublishController speaker changes", () => {
  it("restarts the publisher when the resumed set changes", async () => {
    const cluster = makeCluster([{ producerId: "a" }]);
    const { controller, publisher, flush } = setup(cluster);
    controller.onModeTransition("room1", "promote");
    await flush();

    // A second speaker joins.
    (cluster as any).producers.push({ producerId: "b" });
    controller.onSpeakerChange("room1");
    await flush();

    expect(publisher.restart).toHaveBeenCalledWith("sdp", 2);
  });

  it("does NOT restart when the set is unchanged (e.g. self-mute keeps producer live)", async () => {
    const { controller, publisher, flush } = setup(
      makeCluster([{ producerId: "a" }]),
    );
    controller.onModeTransition("room1", "promote");
    await flush();

    controller.onSpeakerChange("room1"); // same set
    await flush();

    expect(publisher.restart).not.toHaveBeenCalled();
  });

  it("stops encoding when all speakers leave, keeping the session", async () => {
    const cluster = makeCluster([{ producerId: "a" }]);
    const { controller, publisher, flush } = setup(cluster);
    controller.onModeTransition("room1", "promote");
    await flush();

    (cluster as any).producers.length = 0;
    controller.onSpeakerChange("room1");
    await flush();

    expect(publisher.stop).toHaveBeenCalled();
    expect(controller.isBroadcasting("room1")).toBe(false);
    // Session retained: a returning speaker re-starts without a new promote.
    expect(publisher.start).toHaveBeenCalledTimes(1);
  });
});

describe("BroadcastPublishController gating", () => {
  it("is a no-op when disabled", async () => {
    const { controller, mixer, publisher, flush } = setup(
      makeCluster([{ producerId: "a" }]),
      false,
    );
    controller.onModeTransition("room1", "promote");
    await flush();
    expect(mixer.sync).not.toHaveBeenCalled();
    expect(publisher.start).not.toHaveBeenCalled();
    expect(controller.isBroadcasting("room1")).toBe(false);
  });

  it("onRoomClosed tears down the session", async () => {
    const { controller, publisher, mixer, flush } = setup(
      makeCluster([{ producerId: "a" }]),
    );
    controller.onModeTransition("room1", "promote");
    await flush();

    controller.onRoomClosed("room1");
    await flush();

    expect(mixer.close).toHaveBeenCalled();
    expect(publisher.stop).toHaveBeenCalled();
  });
});
