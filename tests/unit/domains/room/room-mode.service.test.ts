import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";
import type { RoomMode } from "@src/domains/room/types.js";

// Mutable so damping tests can dial the grace window per-case (vi.mock is static).
const mockConfig = vi.hoisted(() => ({
  ROOM_BROADCAST_THRESHOLD_UP: 1500,
  ROOM_BROADCAST_THRESHOLD_DOWN: 1000,
  // realtime-19: 0 by default so the pre-existing (non-damping) cases demote
  // immediately; damping cases raise it.
  ROOM_BROADCAST_DEMOTE_GRACE_MS: 0,
  // realtime-09: enabled so the broadcast flip carries the HLS playback URL.
  BROADCAST_HLS_ENABLED: true,
  HLS_PUBLIC_BASE_URL: "https://live.flyliveapp.com",
}));

vi.mock("@src/config/index.js", () => ({ config: mockConfig }));

import { RoomModeService } from "@src/domains/room/mode/room-mode.service.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeService(opts: {
  currentMode: RoomMode | null;
  setModeResult?: RoomMode | null;
}) {
  const emit = vi.fn();
  const io = { to: vi.fn(() => ({ emit })) } as unknown as Server;
  const state = {
    get: vi
      .fn()
      .mockResolvedValue(
        opts.currentMode === null ? null : { id: "r", mode: opts.currentMode },
      ),
    setMode: vi
      .fn()
      .mockResolvedValue(
        opts.setModeResult === undefined ? "broadcast" : opts.setModeResult,
      ),
  } as unknown as RoomStateRepository & {
    get: ReturnType<typeof vi.fn>;
    setMode: ReturnType<typeof vi.fn>;
  };
  const service = new RoomModeService(state, io, logger);
  return { service, state, io, emit };
}

describe("RoomModeService.evaluate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.ROOM_BROADCAST_DEMOTE_GRACE_MS = 0;
  });

  it("flips interactive→broadcast, persists, and emits room:mode when the threshold is crossed", async () => {
    const { service, state, io, emit } = makeService({
      currentMode: "interactive",
      setModeResult: "broadcast",
    });

    const result = await service.evaluate("r", 2000, 1);

    expect(result).toBe("broadcast");
    expect(state.setMode).toHaveBeenCalledWith("r", "broadcast");
    expect(io.to).toHaveBeenCalledWith("r");
    expect(emit).toHaveBeenCalledWith(
      "room:mode",
      expect.objectContaining({
        roomId: "r",
        mode: "broadcast",
        transition: "promote",
        listenerCount: 2000,
        // realtime-09: the deterministic HLS URL rides the flip so in-room
        // Listeners switch transport immediately.
        hlsPlaybackUrl: "https://live.flyliveapp.com/r/master.m3u8",
      }),
    );
  });

  it("holds inside the hysteresis band — no persist, no emit", async () => {
    const { service, state, emit } = makeService({ currentMode: "interactive" });

    const result = await service.evaluate("r", 1200, 1);

    expect(result).toBe("interactive");
    expect(state.setMode).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("returns null and skips work when the Room state is gone (closed)", async () => {
    const { service, state, emit } = makeService({ currentMode: null });

    const result = await service.evaluate("r", 5000, 1);

    expect(result).toBeNull();
    expect(state.setMode).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("abandons the flip (no emit) when setMode races a close and returns null", async () => {
    const { service, emit } = makeService({
      currentMode: "interactive",
      setModeResult: null,
    });

    const result = await service.evaluate("r", 2000, 1);

    expect(result).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits a null hlsPlaybackUrl on demote so Listeners drop HLS and resume WebRTC", async () => {
    const { service, emit } = makeService({
      currentMode: "broadcast",
      setModeResult: "interactive",
    });

    await service.evaluate("r", 500, 1); // below DOWN threshold → demote

    expect(emit).toHaveBeenCalledWith(
      "room:mode",
      expect.objectContaining({
        mode: "interactive",
        transition: "demote",
        hlsPlaybackUrl: null,
      }),
    );
  });
});

describe("RoomModeService demote damping (realtime-19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockConfig.ROOM_BROADCAST_DEMOTE_GRACE_MS = 20_000;
  });
  afterEach(() => vi.useRealTimers());

  it("holds broadcast while a demote-eligible condition is younger than the grace window", async () => {
    const { service, state, emit } = makeService({
      currentMode: "broadcast",
      setModeResult: "interactive",
    });

    // First eligible tick — under grace → held, no teardown.
    expect(await service.evaluate("r", 500, 1)).toBe("broadcast");
    // Still under grace 10s later.
    vi.setSystemTime(10_000);
    expect(await service.evaluate("r", 500, 1)).toBe("broadcast");

    expect(state.setMode).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("demotes once the condition has held continuously past the grace window", async () => {
    const { service, state, emit } = makeService({
      currentMode: "broadcast",
      setModeResult: "interactive",
    });

    await service.evaluate("r", 500, 1); // eligible @ t=0, held
    vi.setSystemTime(20_001); // just past the 20s grace
    const result = await service.evaluate("r", 500, 1);

    expect(result).toBe("interactive");
    expect(state.setMode).toHaveBeenCalledWith("r", "interactive");
    expect(emit).toHaveBeenCalledWith(
      "room:mode",
      expect.objectContaining({ transition: "demote" }),
    );
  });

  it("resets the streak when listeners recover above the floor mid-damping", async () => {
    const { service, state } = makeService({
      currentMode: "broadcast",
      setModeResult: "interactive",
    });

    await service.evaluate("r", 500, 1); // eligible @ t=0
    vi.setSystemTime(10_000);
    await service.evaluate("r", 1200, 1); // recovered into band → streak reset
    vi.setSystemTime(15_000);
    await service.evaluate("r", 500, 1); // eligible again @ t=15_000
    vi.setSystemTime(30_000); // 30s since t=0 (> grace) BUT only 15s since reset

    expect(await service.evaluate("r", 500, 1)).toBe("broadcast");
    // Would have demoted if the streak hadn't reset at t=10_000.
    expect(state.setMode).not.toHaveBeenCalled();
  });

  it("promote is never damped — it fires immediately regardless of grace", async () => {
    const { service, state } = makeService({
      currentMode: "interactive",
      setModeResult: "broadcast",
    });

    expect(await service.evaluate("r", 2000, 1)).toBe("broadcast");
    expect(state.setMode).toHaveBeenCalledWith("r", "broadcast");
  });

  it("forget() clears the streak so a torn-down room can't leak or demote on stale time", async () => {
    const { service, state } = makeService({
      currentMode: "broadcast",
      setModeResult: "interactive",
    });

    await service.evaluate("r", 500, 1); // eligible @ t=0
    vi.setSystemTime(15_000);
    service.forget("r"); // room evicted/closed
    vi.setSystemTime(25_000); // 25s since t=0 (> grace) — would demote without forget

    // Streak restarts at t=25_000 → held, no demote.
    expect(await service.evaluate("r", 500, 1)).toBe("broadcast");
    expect(state.setMode).not.toHaveBeenCalled();
  });
});
