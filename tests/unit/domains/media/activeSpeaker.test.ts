import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("@src/config/index.js", () => ({
  config: {
    MAX_ACTIVE_SPEAKERS_FORWARDED: 3,
  },
}));

import { ActiveSpeakerDetector } from "@src/domains/media/activeSpeaker.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockObserver() {
  const handlers = new Map<string, Function>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    removeAllListeners: vi.fn(),
    // Test helper: fire the dominantspeaker event
    _fire: (producerId: string, userId: string) => {
      const handler = handlers.get("dominantspeaker");
      if (handler) {
        handler({
          producer: {
            id: producerId,
            appData: { userId },
          },
        });
      }
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ─── Tests ──────────────────────────────────────────────────────────

describe("ActiveSpeakerDetector", () => {
  let observer: ReturnType<typeof createMockObserver>;
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    observer = createMockObserver();
    io = createMockIO();
  });

  describe("start()", () => {
    it("registers a dominantspeaker listener on the observer", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);
      detector.start();

      expect(observer.on).toHaveBeenCalledWith("dominantspeaker", expect.any(Function));
    });

    it("emits speaker:active to the room on first dominant speaker", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);
      detector.start();

      observer._fire("prod-1", "user-1");

      expect(io.to).toHaveBeenCalledWith("room-1");
      expect(io._emit).toHaveBeenCalledWith(
        "speaker:active",
        expect.objectContaining({
          userId: "user-1",
          activeSpeakers: expect.arrayContaining(["user-1"]),
        }),
      );
    });
  });

  describe("computeTopN()", () => {
    it("returns at most MAX_ACTIVE_SPEAKERS_FORWARDED speakers", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);
      detector.start();

      // Fire 5 different speakers (config max is 3)
      observer._fire("prod-1", "user-1");
      observer._fire("prod-2", "user-2");
      observer._fire("prod-3", "user-3");
      observer._fire("prod-4", "user-4");
      observer._fire("prod-5", "user-5");

      // Access currentActiveSpeakers via the last emitted event
      const lastCall = io._emit.mock.calls[io._emit.mock.calls.length - 1];
      const payload = lastCall?.[1];
      expect(payload.activeSpeakers.length).toBeLessThanOrEqual(3);
    });

    it("evicts speakers older than 10 seconds", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);
      detector.start();

      // Fire a speaker, then advance time past 10s stale cutoff
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      observer._fire("prod-1", "user-1");

      // Advance to 11 seconds later
      vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
      observer._fire("prod-2", "user-2");

      // prod-1 should be evicted (stale), only prod-2 active
      const lastCall = io._emit.mock.calls[io._emit.mock.calls.length - 1];
      const payload = lastCall?.[1];
      expect(payload.activeSpeakers).toContain("user-2");
      expect(payload.activeSpeakers).not.toContain("user-1");
    });
  });

  describe("PERF-003: no-emit on unchanged set", () => {
    it("does not emit when the same speaker fires twice consecutively", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);
      detector.start();

      observer._fire("prod-1", "user-1");
      const emitCountAfterFirst = io._emit.mock.calls.length;

      // Same speaker fires again — set shouldn't change
      observer._fire("prod-1", "user-1");
      expect(io._emit.mock.calls.length).toBe(emitCountAfterFirst);
    });
  });

  describe("cluster integration", () => {
    it("calls cluster.updateActiveSpeakers when active set changes", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);

      const mockCluster = {
        updateActiveSpeakers: vi.fn().mockResolvedValue(undefined),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detector.setCluster(mockCluster as any);
      detector.start();

      observer._fire("prod-1", "user-1");

      expect(mockCluster.updateActiveSpeakers).toHaveBeenCalledWith(["prod-1"]);
    });

    it("logs error if cluster.updateActiveSpeakers rejects", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);

      const mockCluster = {
        updateActiveSpeakers: vi.fn().mockRejectedValue(new Error("fail")),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detector.setCluster(mockCluster as any);
      detector.start();

      observer._fire("prod-1", "user-1");

      // Wait for promise rejection to be handled
      await vi.waitFor(() => {
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ roomId: "room-1" }),
          "Failed to update active speakers on cluster",
        );
      });
    });
  });

  describe("stop()", () => {
    it("removes all listeners and clears state", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new ActiveSpeakerDetector(observer as any, "room-1", io as any, mockLogger);
      detector.start();

      observer._fire("prod-1", "user-1");
      detector.stop();

      expect(observer.removeAllListeners).toHaveBeenCalled();
      // After stop, internal state should be cleared
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((detector as any).recentSpeakers.size).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((detector as any).currentActiveSpeakers.length).toBe(0);
    });
  });
});
