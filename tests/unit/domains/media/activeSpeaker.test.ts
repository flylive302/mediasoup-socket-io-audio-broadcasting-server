import { describe, it, expect, vi, beforeEach } from "vitest";

import { ActiveSpeakerDetector } from "@src/domains/media/activeSpeaker.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockObserver() {
  const handlers = new Map<string, Function>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    removeAllListeners: vi.fn(),
    // Test helper: fire a volumes tick with the given speakers
    _volumes: (entries: Array<{ producerId: string; userId: string }>) => {
      handlers.get("volumes")?.(
        entries.map((e) => ({
          producer: { id: e.producerId, appData: { userId: e.userId } },
          volume: -40,
        })),
      );
    },
    // Test helper: fire the silence event
    _silence: () => {
      handlers.get("silence")?.();
    },
  };
}

function createMockIO() {
  const emitFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    _emit: emitFn,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("ActiveSpeakerDetector", () => {
  let observer: ReturnType<typeof createMockObserver>;
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    observer = createMockObserver();
    io = createMockIO();
  });

  function makeDetector(): ActiveSpeakerDetector {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any);
    detector.start();
    return detector;
  }

  describe("start()", () => {
    it("registers volumes and silence listeners on the observer", () => {
      makeDetector();

      expect(observer.on).toHaveBeenCalledWith("volumes", expect.any(Function));
      expect(observer.on).toHaveBeenCalledWith("silence", expect.any(Function));
    });

    it("emits speaker:active with all concurrent speakers on a volumes tick", () => {
      makeDetector();

      observer._volumes([
        { producerId: "prod-1", userId: "user-1" },
        { producerId: "prod-2", userId: "user-2" },
      ]);

      expect(io.to).toHaveBeenCalledWith("room-1");
      expect(io._emit).toHaveBeenCalledWith(
        "speaker:active",
        expect.objectContaining({
          activeSpeakers: ["user-1", "user-2"],
        }),
      );
    });

    it("dedupes multiple producers of the same user", () => {
      makeDetector();

      observer._volumes([
        { producerId: "prod-1", userId: "user-1" },
        { producerId: "prod-1b", userId: "user-1" },
      ]);

      const payload = io._emit.mock.calls.at(-1)?.[1];
      expect(payload.activeSpeakers).toEqual(["user-1"]);
    });

    it("re-emits on every tick even when the set is unchanged (keeps FE decay fresh)", () => {
      makeDetector();

      observer._volumes([{ producerId: "prod-1", userId: "user-1" }]);
      observer._volumes([{ producerId: "prod-1", userId: "user-1" }]);

      expect(io._emit).toHaveBeenCalledTimes(2);
    });

    it("emits an empty set on silence", () => {
      makeDetector();

      observer._volumes([{ producerId: "prod-1", userId: "user-1" }]);
      observer._silence();

      const payload = io._emit.mock.calls.at(-1)?.[1];
      expect(payload.activeSpeakers).toEqual([]);
    });
  });

  describe("stop()", () => {
    it("removes all listeners", () => {
      const detector = makeDetector();
      detector.stop();

      expect(observer.removeAllListeners).toHaveBeenCalled();
    });
  });
});
