/**
 * room-role-badge: the joiner's rank is resolved in the background (never on
 * the join's await path), tagged per room on socket.data, and announced via
 * room:userRole. Membership relay events re-tag local sockets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ROOM_USER_ROLE_EVENT,
  resolveJoinerRoomRole,
  retagRoomRoleOnLocalSockets,
  roleFromMembershipEvent,
  roomRoleFor,
} from "@src/domains/room/room-role.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeSocket(roomIds: string[], connected = true) {
  const roomEmit = vi.fn();
  return {
    connected,
    rooms: new Set(roomIds),
    data: { user: { id: 7 } } as Record<string, any>,
    nsp: { to: vi.fn(() => ({ emit: roomEmit })) },
    roomEmit,
  } as any;
}

function makeContext(role: unknown) {
  return {
    laravelClient: { getMemberRole: vi.fn().mockResolvedValue(role) },
    cascadeRelay: null,
  } as any;
}

describe("roomRoleFor", () => {
  it("returns the role only when the tag matches the room", () => {
    const data = { roomRole: { roomId: "1", role: "admin" as const } };
    expect(roomRoleFor(data, "1")).toBe("admin");
    expect(roomRoleFor({ roomRole: { roomId: "1", role: null } }, "1")).toBeNull();
    expect(roomRoleFor(data, "2")).toBeUndefined();
    expect(roomRoleFor({}, "1")).toBeUndefined();
    expect(roomRoleFor(undefined, "1")).toBeUndefined();
  });
});

describe("resolveJoinerRoomRole", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not block: returns before Laravel answers", async () => {
    const socket = makeSocket(["1"]);
    const context = makeContext("member");
    const result = resolveJoinerRoomRole(socket, "1", context);

    expect(result).toBeUndefined();
    expect(socket.data.roomRole).toBeUndefined();
    await flush();
    expect(context.laravelClient.getMemberRole).toHaveBeenCalledWith("1", "7");
  });

  it("never throws synchronously, even if the client does", async () => {
    const socket = makeSocket(["1"]);
    const context = {
      laravelClient: { getMemberRole: () => { throw new Error("sync boom"); } },
      cascadeRelay: null,
    } as any;

    expect(() => resolveJoinerRoomRole(socket, "1", context)).not.toThrow();
    await flush();
    expect(socket.data.roomRole).toBeUndefined();
  });

  it("tags the socket and broadcasts the role (sender included)", async () => {
    const socket = makeSocket(["1"]);
    resolveJoinerRoomRole(socket, "1", makeContext("admin"));
    await flush();

    expect(socket.data.roomRole).toEqual({ roomId: "1", role: "admin" });
    expect(socket.nsp.to).toHaveBeenCalledWith("1");
    expect(socket.roomEmit).toHaveBeenCalledWith(ROOM_USER_ROLE_EVENT, {
      userId: 7,
      role: "admin",
    });
  });

  it("tags a non-member as null without emitting", async () => {
    const socket = makeSocket(["1"]);
    resolveJoinerRoomRole(socket, "1", makeContext(null));
    await flush();

    expect(socket.data.roomRole).toEqual({ roomId: "1", role: null });
    expect(socket.roomEmit).not.toHaveBeenCalled();
  });

  it("drops the result when the user left the room meanwhile", async () => {
    const socket = makeSocket([]);
    resolveJoinerRoomRole(socket, "1", makeContext("owner"));
    await flush();

    expect(socket.data.roomRole).toBeUndefined();
    expect(socket.roomEmit).not.toHaveBeenCalled();
  });

  it("swallows a rejected lookup", async () => {
    const socket = makeSocket(["1"]);
    const context = {
      laravelClient: { getMemberRole: vi.fn().mockRejectedValue(new Error("boom")) },
      cascadeRelay: null,
    } as any;
    resolveJoinerRoomRole(socket, "1", context);
    await flush();

    expect(socket.data.roomRole).toBeUndefined();
  });
});

describe("retagRoomRoleOnLocalSockets", () => {
  it("re-tags only this user's local sockets that are in the room", async () => {
    const inRoom = makeSocket(["1"]);
    const elsewhere = makeSocket(["2"]);
    const io = {
      sockets: {
        sockets: new Map<string, any>([
          ["a", inRoom],
          ["b", elsewhere],
        ]),
      },
    } as any;
    const repo = { getSocketIds: vi.fn().mockResolvedValue(["a", "b", "gone"]) } as any;

    await retagRoomRoleOnLocalSockets(io, repo, "1", 7, "admin");

    expect(inRoom.data.roomRole).toEqual({ roomId: "1", role: "admin" });
    expect(elsewhere.data.roomRole).toBeUndefined();
  });
});

describe("roleFromMembershipEvent", () => {
  it.each([
    ["room.member_joined", { role: "member" }, "member"],
    ["room.member_joined", {}, "member"],
    ["room.member_role_changed", { new_role: "admin" }, "admin"],
    ["room.member_role_changed", { new_role: "member" }, "member"],
    ["room.member_left", {}, null],
    ["room.member_removed", {}, null],
  ])("%s %j → %s", (event, payload, expected) => {
    expect(roleFromMembershipEvent(event, payload)).toBe(expected);
  });

  it("ignores unrelated events and unknown roles", () => {
    expect(roleFromMembershipEvent("room.updated", {})).toBeUndefined();
    expect(roleFromMembershipEvent("room.member_role_changed", { new_role: "moderator" })).toBeUndefined();
  });
});
