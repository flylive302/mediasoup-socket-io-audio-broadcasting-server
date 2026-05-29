import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: { INTERNAL_API_KEY: "test-key" },
}));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { OriginSnapshot } from "@src/domains/cascade/origin-snapshot.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

function createSnapshot() {
  return new OriginSnapshot(mockLogger);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("OriginSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ── fetchOriginInstanceId ─────────────────────────────────────────────

  describe("fetchOriginInstanceId", () => {
    it("returns instanceId from health endpoint on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ instanceId: "origin-abc" }),
        }),
      );

      const snapshot = createSnapshot();
      const result = await snapshot.fetchOriginInstanceId("http://origin:3030");

      expect(result).toBe("origin-abc");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchMock = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://origin:3030/internal/health",
        expect.objectContaining({ headers: { "X-Internal-Key": "test-key" } }),
      );
    });

    it("returns null when response is not ok", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      );
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginInstanceId("http://origin:3030")).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginInstanceId("http://origin:3030")).toBeNull();
    });

    it("returns null when instanceId is blank", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instanceId: "  " }) }),
      );
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginInstanceId("http://origin:3030")).toBeNull();
    });
  });

  // ── fetchOriginProducers ──────────────────────────────────────────────

  describe("fetchOriginProducers", () => {
    it("returns producers array from origin", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            status: "ok",
            producers: [{ producerId: "p-1", userId: 42, kind: "audio" }],
          }),
        }),
      );

      const snapshot = createSnapshot();
      const result = await snapshot.fetchOriginProducers("http://origin:3030", "room-1");

      expect(result).toEqual([{ producerId: "p-1", userId: 42, kind: "audio" }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchMock = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://origin:3030/internal/room/room-1/producers",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns null on HTTP error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginProducers("http://origin:3030", "room-1")).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginProducers("http://origin:3030", "room-1")).toBeNull();
    });
  });

  // ── fetchOriginParticipants ───────────────────────────────────────────

  describe("fetchOriginParticipants", () => {
    it("returns participants array from origin", async () => {
      const participant = {
        id: 1, name: "Alice", signature: "s", avatar: "a", frame_id: null,
        chat_bubble_id: null, entry_animation_id: null, data_card_id: null,
        mice_wave_id: null, slides_id: null, gender: 0, country: "US",
        wealth_xp: "0", charm_xp: "0", vip_level: 0, isSpeaker: false,
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "ok", participants: [participant] }),
        }),
      );

      const snapshot = createSnapshot();
      const result = await snapshot.fetchOriginParticipants("http://origin:3030", "room-1");

      expect(result).toEqual([participant]);
    });

    it("returns null on HTTP error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginParticipants("http://origin:3030", "room-1")).toBeNull();
    });
  });

  // ── fetchOriginRoomSnapshot ───────────────────────────────────────────

  describe("fetchOriginRoomSnapshot", () => {
    it("returns room snapshot from origin", async () => {
      const snapshotData = {
        seats: [{ seatIndex: 0, userId: 1, isMuted: false }],
        lockedSeats: [],
        seatCount: 8,
        musicPlayer: null,
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => snapshotData }),
      );

      const snapshot = createSnapshot();
      const result = await snapshot.fetchOriginRoomSnapshot("http://origin:3030", "room-1", 8);

      expect(result).toEqual(snapshotData);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchMock = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://origin:3030/internal/room/room-1/snapshot?seatCount=8",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns null on HTTP error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      const snapshot = createSnapshot();
      expect(await snapshot.fetchOriginRoomSnapshot("http://origin:3030", "room-1", 8)).toBeNull();
    });
  });
});
