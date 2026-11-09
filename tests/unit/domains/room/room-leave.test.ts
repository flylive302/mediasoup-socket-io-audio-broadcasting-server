import { describe, expect, it, vi } from "vitest";

// room-video-player/03 — an explicit room:leave (and the F-31 room switch, which
// shares performRoomLeave) releases the Controller's Room Video AFTER the normal
// teardown. The disconnect path never goes through here (lifecycle hook instead).

const calls: string[] = [];
const finalizeLeaveMock = vi.fn(async () => {
  calls.push("finalizeLeave");
  return 0;
});
vi.mock("@src/domains/room/leave-finalizer.js", () => ({
  finalizeLeave: (...args: unknown[]) => finalizeLeaveMock(...(args as [])),
}));

const releaseVideoOnRoomLeaveMock = vi.fn(async () => {
  calls.push("releaseVideo");
});
vi.mock("@src/domains/video-player/index.js", () => ({
  releaseVideoOnRoomLeave: (...args: unknown[]) => releaseVideoOnRoomLeaveMock(...(args as [])),
}));

import { performRoomLeave } from "@src/domains/room/room-leave.js";

describe("performRoomLeave", () => {
  it("runs the explicit-leave teardown, then the Room Video release", async () => {
    const socket = { id: "s1" } as any;
    const context = {} as any;

    await performRoomLeave(socket, context, "room-1");

    expect(finalizeLeaveMock).toHaveBeenCalledWith(socket, context, "room-1", { viaDisconnect: false });
    expect(releaseVideoOnRoomLeaveMock).toHaveBeenCalledWith(socket, context, "room-1");
    expect(calls).toEqual(["finalizeLeave", "releaseVideo"]);
  });
});
