import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import type { LaravelClient } from "@src/integrations/laravelClient.js";
import type { RoomStatusUpdate } from "@src/integrations/types.js";
import { StatusCoalescer } from "@src/domains/room/status-coalescer.js";

// ─── Helpers ────────────────────────────────────────────────────────

const WINDOW_MS = 3000;

function createMockLaravel() {
  return {
    updateRoomStatus: vi.fn<(roomId: string, s: RoomStatusUpdate) => Promise<void>>(
      async () => {},
    ),
  } as unknown as LaravelClient & {
    updateRoomStatus: ReturnType<typeof vi.fn>;
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function live(count: number): RoomStatusUpdate {
  return { is_live: count > 0, participant_count: count };
}

describe("StatusCoalescer", () => {
  let laravel: ReturnType<typeof createMockLaravel>;
  let coalescer: StatusCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    laravel = createMockLaravel();
    coalescer = new StatusCoalescer(laravel, logger, WINDOW_MS);
    coalescer.start();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits at most ONE status update per Room per window, with the latest value", async () => {
    coalescer.submit("r1", live(1));
    coalescer.submit("r1", live(2));
    coalescer.submit("r1", live(3));

    // Nothing sent before the window elapses.
    expect(laravel.updateRoomStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);
    expect(laravel.updateRoomStatus).toHaveBeenCalledWith("r1", live(3));
  });

  it("flushes each Room independently within one window tick", async () => {
    coalescer.submit("r1", live(5));
    coalescer.submit("r2", live(0));

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(2);
    expect(laravel.updateRoomStatus).toHaveBeenCalledWith("r1", live(5));
    expect(laravel.updateRoomStatus).toHaveBeenCalledWith("r2", live(0));
  });

  it("does not re-emit once a window has drained the buffer", async () => {
    coalescer.submit("r1", live(2));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);

    // A second window with no new submits sends nothing.
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);
  });

  it("flushNow sends immediately and cancels the buffered entry for that Room", async () => {
    coalescer.submit("r1", live(4)); // a stale participant update is buffered…
    await coalescer.flushNow("r1", { is_live: false, participant_count: 0 }); // …close pre-empts it

    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);
    expect(laravel.updateRoomStatus).toHaveBeenCalledWith("r1", {
      is_live: false,
      participant_count: 0,
    });

    // The buffered is_live:true must NOT resurface on the next window tick.
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);
  });

  it("forget drops a buffered entry without sending it", async () => {
    coalescer.submit("r1", live(7));
    coalescer.forget("r1");

    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(laravel.updateRoomStatus).not.toHaveBeenCalled();
  });

  it("stop() flushes anything still pending and halts the timer", async () => {
    coalescer.submit("r1", live(9));
    await coalescer.stop();

    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);
    expect(laravel.updateRoomStatus).toHaveBeenCalledWith("r1", live(9));

    // Timer is cleared — further time passing emits nothing more.
    coalescer.submit("r2", live(1));
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(laravel.updateRoomStatus).toHaveBeenCalledTimes(1);
  });

  it("swallows a Laravel flush failure (fire-and-forget, never throws)", async () => {
    laravel.updateRoomStatus.mockRejectedValueOnce(new Error("boom"));
    coalescer.submit("r1", live(1));

    // The flush must not throw; the failure is logged and swallowed.
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(logger.error).toHaveBeenCalled();
  });
});
