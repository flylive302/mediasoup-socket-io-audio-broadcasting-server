import { describe, it, expect, vi } from "vitest";

let mockRoomTickMs = 0;
const mockEnqueueLucky = vi.fn();
vi.mock("@src/domains/gift/roomTicker.js", () => ({
  enqueueLucky: (...args: unknown[]) => mockEnqueueLucky(...args),
}));
vi.mock("@src/domains/gift/flags.js", () => ({
  giftRoomTickMs: () => mockRoomTickMs,
}));

import { deliverLuckyRoomResult } from "@src/domains/gift/luckyDelivery.js";

function createMockIo(localSize = 3) {
  const emitFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    sockets: { adapter: { rooms: new Map([["42", { size: localSize }]]) } },
    _emit: emitFn,
  };
}

describe("deliverLuckyRoomResult", () => {
  it("emits directly when the room ticker is off", () => {
    mockRoomTickMs = 0;
    const io = createMockIo();
    const localCount = deliverLuckyRoomResult(io as any, "42", { winnerId: 9 });

    expect(io.to).toHaveBeenCalledWith("42");
    expect(io._emit).toHaveBeenCalledWith("lucky:room-result", { winnerId: 9 });
    expect(mockEnqueueLucky).not.toHaveBeenCalled();
    expect(localCount).toBe(3);
  });

  it("folds into the room ticker instead of a direct emit when the ticker is on", () => {
    mockRoomTickMs = 100;
    const io = createMockIo();
    const localCount = deliverLuckyRoomResult(io as any, "42", { winnerId: 9 });

    expect(mockEnqueueLucky).toHaveBeenCalledWith("42", { winnerId: 9 });
    expect(io.to).not.toHaveBeenCalled();
    expect(localCount).toBe(3);
  });

  it("returns 0 for a room with no local sockets", () => {
    mockRoomTickMs = 0;
    const io = createMockIo(0);
    io.sockets.adapter.rooms.clear();
    const localCount = deliverLuckyRoomResult(io as any, "99", { winnerId: 1 });

    expect(localCount).toBe(0);
  });
});
