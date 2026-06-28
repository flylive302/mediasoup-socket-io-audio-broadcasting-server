import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";
import type { RoomMode } from "@src/domains/room/types.js";

vi.mock("@src/config/index.js", () => ({
  config: { ROOM_BROADCAST_THRESHOLD_UP: 1500, ROOM_BROADCAST_THRESHOLD_DOWN: 1000 },
}));

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
  beforeEach(() => vi.clearAllMocks());

  it("flips interactive→broadcast, persists, and emits room:mode when the threshold is crossed", async () => {
    const { service, state, io, emit } = makeService({
      currentMode: "interactive",
      setModeResult: "broadcast",
    });

    const result = await service.evaluate("r", 2000);

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
      }),
    );
  });

  it("holds inside the hysteresis band — no persist, no emit", async () => {
    const { service, state, emit } = makeService({ currentMode: "interactive" });

    const result = await service.evaluate("r", 1200);

    expect(result).toBe("interactive");
    expect(state.setMode).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("returns null and skips work when the Room state is gone (closed)", async () => {
    const { service, state, emit } = makeService({ currentMode: null });

    const result = await service.evaluate("r", 5000);

    expect(result).toBeNull();
    expect(state.setMode).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("abandons the flip (no emit) when setMode races a close and returns null", async () => {
    const { service, emit } = makeService({
      currentMode: "interactive",
      setModeResult: null,
    });

    const result = await service.evaluate("r", 2000);

    expect(result).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});
