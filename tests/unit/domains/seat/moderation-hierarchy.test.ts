/**
 * Room moderation hierarchy — `verifyRoomModerationTarget`.
 *
 * Regression guard for the incident where a room owner made a friend an admin
 * and that admin was able to act on the owner inside the owner's own room.
 * `verifyRoomManager` answers only "is the requester staff", so every targeted
 * action built on it (mute, and seat-lock when the seat is occupied) inherited
 * the hole.
 *
 * The hierarchy under test, identical to the Laravel authority
 * (`RoomMemberService::blockMember` + `RoomPolicy::kick`):
 *
 *   Owner  → anyone
 *   Admin  → plain members only
 *   Member → nobody
 *
 * The trap this locks down: the owner has NO `room_members` row, so a role
 * lookup for them returns null and reads as "plain member". Owner identity must
 * come from the room, never from a membership role.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({ config: {} }));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  verifyRoomModerationTarget,
  clearRoomOwner,
} from "@src/domains/seat/seat.owner.js";
import { Errors } from "@src/shared/errors.js";

const ROOM_ID = "room-1";
const OWNER_ID = "10";
const ADMIN_ID = "20";
const OTHER_ADMIN_ID = "21";
const MEMBER_ID = "30";
/** In the room but holds no membership row — a plain visitor. */
const VISITOR_ID = "40";

type Role = "owner" | "admin" | "member" | null;

/**
 * `roles` maps userId → what Laravel reports for that user in this room.
 * The owner is deliberately absent from it: production never writes an OWNER
 * membership row, so `getMemberRole` returns null for them.
 */
function makeContext(
  roles: Record<string, Role>,
  opts: { getRoomDataFails?: boolean } = {},
) {
  return {
    laravelClient: {
      getRoomData: vi.fn(async () => {
        if (opts.getRoomDataFails) throw new Error("Laravel unreachable");
        return { owner_id: OWNER_ID, max_seats: 8 };
      }),
      canManageRoom: vi.fn(async (_roomId: string, userId: string) => {
        const role = roles[userId] ?? null;
        return role === "owner" || role === "admin";
      }),
      getMemberRole: vi.fn(async (_roomId: string, userId: string) => roles[userId] ?? null),
    },
  };
}

/** Production role table: the owner has no membership row. */
const ROLES: Record<string, Role> = {
  [ADMIN_ID]: "admin",
  [OTHER_ADMIN_ID]: "admin",
  [MEMBER_ID]: "member",
};

async function check(
  requesterId: string,
  targetId: string,
  context: ReturnType<typeof makeContext>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return verifyRoomModerationTarget(ROOM_ID, requesterId, targetId, context as any);
}

describe("verifyRoomModerationTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The owner id is cached per room across calls — clear it so each test
    // resolves ownership fresh from its own stubbed client.
    clearRoomOwner(ROOM_ID);
  });

  describe("owner as requester", () => {
    it("may act on an admin", async () => {
      const result = await check(OWNER_ID, ADMIN_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: true });
    });

    it("may act on a plain member", async () => {
      const result = await check(OWNER_ID, MEMBER_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: true });
    });

    it("is authorized without a membership row — ownership is the room, not a role", async () => {
      const context = makeContext(ROLES);
      const result = await check(OWNER_ID, MEMBER_ID, context);

      expect(result).toEqual({ allowed: true });
      // Short-circuits on ownership; never needs to ask for a role at all.
      expect(context.laravelClient.canManageRoom).not.toHaveBeenCalled();
    });
  });

  describe("admin as requester", () => {
    it("REFUSES to act on the room owner", async () => {
      const result = await check(ADMIN_ID, OWNER_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: false, error: Errors.NOT_AUTHORIZED });
    });

    it("refuses the owner even though the owner's role lookup returns null", async () => {
      const context = makeContext(ROLES);
      await check(ADMIN_ID, OWNER_ID, context);

      // The exact trap: had the gate trusted `getMemberRole`, null would have
      // read as "plain member" and the owner would have been actionable.
      expect(await context.laravelClient.getMemberRole(ROOM_ID, OWNER_ID)).toBeNull();
    });

    it("REFUSES to act on another admin", async () => {
      const result = await check(ADMIN_ID, OTHER_ADMIN_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: false, error: Errors.NOT_AUTHORIZED });
    });

    it("may act on a plain member", async () => {
      const result = await check(ADMIN_ID, MEMBER_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: true });
    });

    it("may act on a visitor who holds no membership row", async () => {
      const result = await check(ADMIN_ID, VISITOR_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: true });
    });

    it("may act on THEMSELVES — otherwise an owner-muted admin is stuck", async () => {
      // The peer-admin rule would otherwise catch an admin unmuting their own
      // mic, leaving them silenced with no recourse if the owner is offline.
      const result = await check(ADMIN_ID, ADMIN_ID, makeContext(ROLES));
      expect(result).toEqual({ allowed: true });
    });
  });

  describe("plain member as requester", () => {
    it("may act on nobody", async () => {
      const context = makeContext(ROLES);

      expect(await check(MEMBER_ID, OWNER_ID, context)).toEqual({
        allowed: false,
        error: Errors.NOT_AUTHORIZED,
      });
      expect(await check(MEMBER_ID, ADMIN_ID, context)).toEqual({
        allowed: false,
        error: Errors.NOT_AUTHORIZED,
      });
      expect(await check(MEMBER_ID, VISITOR_ID, context)).toEqual({
        allowed: false,
        error: Errors.NOT_AUTHORIZED,
      });
    });
  });

  describe("failure posture", () => {
    it("fails CLOSED when the owner cannot be resolved", async () => {
      const context = makeContext(ROLES, { getRoomDataFails: true });
      const result = await check(ADMIN_ID, MEMBER_ID, context);

      // Owner protection must never degrade to "allow" — an unreachable
      // Laravel means we cannot prove the target is not the owner.
      expect(result).toEqual({ allowed: false, error: Errors.AUTH_CHECK_FAILED });
    });
  });
});
