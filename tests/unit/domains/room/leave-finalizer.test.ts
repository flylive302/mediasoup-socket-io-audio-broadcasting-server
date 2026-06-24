import { describe, it, expect, vi, beforeEach } from "vitest";
import { finalizeLeave } from "@src/domains/room/leave-finalizer.js";
import { PresenceTracker } from "@src/domains/room/presence-tracker.js";
import type { Server } from "socket.io";
import type { RoomStateRepository } from "@src/domains/room/roomState.js";
import type { AppContext } from "@src/context.js";

const ROOM = "room-1";
const LEAVER = "sock-leaver";
const LEAVER_ID = 100;

/**
 * Membership-backed harness. `members` is the set of socket ids the Redis
 * adapter reports for ROOM. This is the load-bearing detail the advisor flagged:
 * by the time `disconnect` fires, Socket.IO has ALREADY removed the socket from
 * its rooms, so the disconnect path must pre-remove the leaver; the explicit
 * path removes it via `socket.leave()`. Both must end at the same membership →
 * the same presence count → identical backend updates.
 */
function harness(members: Set<string>) {
  const io = {
    in: () => ({
      fetchSockets: async () => [...members].map((id) => ({ id })),
    }),
  } as unknown as Server;

  const state = {
    reconcileParticipantCount: vi.fn(async (_r: string, count: number) => count),
  } as unknown as RoomStateRepository;

  const presenceTracker = new PresenceTracker(io, state);

  const submit = vi.fn();
  const recordActivity = vi.fn(async () => {});
  const clearUserRoom = vi.fn(async () => {});
  const clearClientRoom = vi.fn();
  const emit = vi.fn();

  const context = {
    roomManager: { getRoom: () => undefined },
    clientManager: {
      getClient: () => ({ transports: new Map() }),
      clearClientRoom,
    },
    seatRepository: { leaveSeat: vi.fn(async () => ({ success: false })) },
    autoCloseService: { recordActivity },
    userRoomRepository: { clearUserRoom },
    presenceTracker,
    statusCoalescer: { submit },
    cascadeRelay: null,
  } as unknown as AppContext;

  const socket = {
    id: LEAVER,
    data: { user: { id: LEAVER_ID } },
    to: () => ({ emit }),
    leave: vi.fn((_room: string) => {
      members.delete(LEAVER);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { context, socket, submit, recordActivity, clearUserRoom, clearClientRoom, emit };
}

async function captureStatus(members: Set<string>, viaDisconnect: boolean) {
  const h = harness(members);
  const count = await finalizeLeave(h.socket, h.context, ROOM, { viaDisconnect });
  // realtime-02: the leave path now buffers the status via the coalescer.
  return { count, status: h.submit.mock.calls[0]?.[1], h };
}

describe("finalizeLeave — symmetric leave/disconnect (Cause A / H3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explicit leave excludes the leaver from the count (others remain → is_live true)", async () => {
    const { count, status } = await captureStatus(new Set([LEAVER, "sock-other"]), false);
    expect(count).toBe(1);
    expect(status).toMatchObject({ is_live: true, participant_count: 1 });
  });

  it("disconnect (socket already removed) yields the SAME count as explicit leave", async () => {
    // Leaver pre-removed, modeling Socket.IO clearing rooms before `disconnect`.
    const { count, status } = await captureStatus(new Set(["sock-other"]), true);
    expect(count).toBe(1);
    expect(status).toMatchObject({ is_live: true, participant_count: 1 });
  });

  it("explicit-leave and disconnect produce IDENTICAL backend updates", async () => {
    const leave = await captureStatus(new Set([LEAVER, "sock-other"]), false);
    const disconnect = await captureStatus(new Set(["sock-other"]), true);
    expect(disconnect.status).toEqual(leave.status);
  });

  it("last participant leaving → is_live false, count 0, hosting cleared (the phantom-live fix)", async () => {
    const leave = await captureStatus(new Set([LEAVER]), false); // socket.leave empties it
    expect(leave.count).toBe(0);
    expect(leave.status).toMatchObject({
      is_live: false,
      participant_count: 0,
      hosting_region: null,
      hosting_ip: null,
      hosting_port: null,
    });

    const disconnect = await captureStatus(new Set(), true); // already empty
    expect(disconnect.count).toBe(0);
    expect(disconnect.status).toEqual(leave.status);
  });

  it("both paths record activity and clear the user-room (symmetric teardown)", async () => {
    for (const viaDisconnect of [false, true]) {
      const members = viaDisconnect ? new Set(["x"]) : new Set([LEAVER, "x"]);
      const { h } = await captureStatus(members, viaDisconnect);
      expect(h.recordActivity).toHaveBeenCalledWith(ROOM);
      expect(h.clearUserRoom).toHaveBeenCalledWith(LEAVER_ID);
      expect(h.clearClientRoom).toHaveBeenCalledWith(LEAVER);
    }
  });
});
