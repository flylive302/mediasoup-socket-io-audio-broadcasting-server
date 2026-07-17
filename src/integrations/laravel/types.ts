/**
 * Laravel Event Types
 * Defines the event structure published by Laravel to Redis pub/sub
 */

/**
 * Event message format from Laravel
 * Published to `flylive:msab:events` channel
 */
export interface LaravelEvent {
  /** Event type (e.g., "balance.updated", "badge.earned") */
  event: string;
  /** Target user ID for private events (null for room/broadcast) */
  user_id: number | null;
  /** Target room ID for room events (null for user/broadcast) */
  room_id: number | null;
  /** Event-specific payload data */
  payload: Record<string, unknown>;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** UUID v4 for tracing/debugging */
  correlation_id: string;
}

/**
 * Routing target for an event
 */
export type EventTarget =
  | { type: "user"; userId: number }
  | { type: "room"; roomId: string }
  | { type: "user_in_room"; userId: number; roomId: string }
  | { type: "broadcast" };

/**
 * Result of routing an event
 */
export interface EventRoutingResult {
  delivered: boolean;
  targetCount: number;
  error?: string;
}

/**
 * Laravel → MSAB Relay Events, grouped by domain.
 *
 * These events originate from the Laravel backend, are published to
 * Redis pub/sub (`flylive:msab:events`), and MSAB relays them to the
 * target user/room socket. MSAB does NOT process these — pure pass-through.
 *
 * Adding a new event:
 * 1. Add the event string to the appropriate domain group below
 * 2. Create a doc in docs/Events/Relay/<Domain>/<event-name>/README.md
 * 3. Coordinate with Laravel to publish the event
 * 4. Coordinate with Frontend to handle the socket event
 */
export const RELAY_EVENTS = {
  /** Economy: balance changes, rewards, coin requests */
  economy: {
    BALANCE_UPDATED: "balance.updated",
    REWARD_EARNED: "reward.earned",
    COIN_REQUEST_STATUS_CHANGED: "coin_request.status_changed",
  },

  /** Achievements: badges, levels */
  achievement: {
    BADGE_EARNED: "badge.earned",
    LEVEL_UP: "level.up",
    USER_PROGRESSION: "user.progression",
  },

  /** Room: level ups, participant counts, membership changes, settings */
  room: {
    ROOM_LEVEL_UP: "room.level_up",
    ROOM_PARTICIPANT_COUNT: "room.participant_count",
    ROOM_MEMBER_JOINED: "room.member_joined",
    ROOM_MEMBER_LEFT: "room.member_left",
    ROOM_MEMBER_REMOVED: "room.member_removed",
    ROOM_MEMBER_ROLE_CHANGED: "room.member_role_changed",
    ROOM_JOIN_REQUEST_CREATED: "room.join_request_created",
    ROOM_JOIN_REQUEST_APPROVED: "room.join_request_approved",
    ROOM_JOIN_REQUEST_REJECTED: "room.join_request_rejected",
    ROOM_UPDATED: "room.updated",
    ROOM_INVITATION_CREATED: "room.invitation_created",
    ROOM_INVITATION_CANCELLED: "room.invitation_cancelled",
    ROOM_INVITATION_DECLINED: "room.invitation_declined",
    ROOM_JOIN_REQUEST_CANCELLED: "room.join_request_cancelled",
    ROOM_USER_UNBLOCKED: "room.user_unblocked",
    // realtime-13 (L2): admin "End Live". NOT pure pass-through — EventRouter
    // intercepts and, if this instance hosts the room's cluster, force-closes
    // it (real teardown + is_live:false/ended_at flush). Laravel reconciles the
    // DB independently, so a non-hosting instance safely no-ops.
    ROOM_FORCE_CLOSE: "room.force_close",
    // Targeted at the owner (user_id envelope) when a room level-up raises
    // the seat cap — pure pass-through.
    ROOM_SEAT_CAP_UNLOCKED: "room.seat_cap_unlocked",
  },

  /** Income Targets: achievement tracking */
  incomeTarget: {
    INCOME_TARGET_COMPLETED: "income_target.completed",
    INCOME_TARGET_MEMBER_COMPLETED: "income_target.member_completed",
  },

  /** Agency: invitations, membership, lifecycle */
  agency: {
    AGENCY_INVITATION: "agency.invitation",
    AGENCY_JOIN_REQUEST: "agency.join_request",
    AGENCY_JOIN_REQUEST_APPROVED: "agency.join_request_approved",
    AGENCY_JOIN_REQUEST_REJECTED: "agency.join_request_rejected",
    AGENCY_MEMBER_KICKED: "agency.member_kicked",
    AGENCY_MEMBER_JOINED: "agency.member_joined",
    AGENCY_MEMBER_LEFT: "agency.member_left",
    AGENCY_DISSOLVED: "agency.dissolved",
    // Agency-XP run progression (economy rework): per-gift XP tick to the
    // member, milestone crossings to member + owner. All user-targeted
    // pass-throughs (user_id envelope).
    AGENCY_XP_PROGRESS: "agency_xp.progress",
    AGENCY_MILESTONE_CROSSED: "agency_milestone.crossed",
    AGENCY_MILESTONE_MEMBER_CROSSED: "agency_milestone.member_crossed",
  },

  /** VIP: status changes, gifting */
  vip: {
    VIP_UPDATED: "vip.updated",
    VIP_GIFTED: "vip.gifted",
  },

  /** System: cache invalidation signals */
  system: {
    CONFIG_INVALIDATE: "config:invalidate",
    ASSET_INVALIDATE: "asset:invalidate",
  },

  /** User: profile updates */
  user: {
    PROFILE_UPDATED: "user.profile.updated",
    USER_FOLLOWED: "user.followed",
    USER_UNFOLLOWED: "user.unfollowed",
  },

  /** Auth: token revocation and force-disconnect (NOT pass-through — EventRouter intercepts) */
  auth: {
    REVOKE_TOKENS: "auth.revoke_tokens",
    FORCE_DISCONNECT: "auth.force_disconnect",
  },

  /**
   * Lucky draw: the sender's floating cashback multiplier. Big-win room/app
   * announcements now flow through the unified slide overlay (`slide:play`),
   * not lucky-specific events — see Laravel unified-slide-overlay (ADR 0009).
   */
  lucky: {
    LUCKY_RESULT: "lucky:result",
  },

  /**
   * Slide overlay (unified-slide-overlay): a resolved triggered SVGA banner.
   * Pure pass-through — routed by room_id presence (room emit) or null
   * (broadcast to all connected users, including those in no room).
   */
  slide: {
    SLIDE_PLAY: "slide:play",
  },

  /** Mission: Recharge Activity winner announcement + finale snapshot signal */
  mission: {
    MISSION_WINNER: "mission.winner",
    MISSION_FINALE_READY: "mission.finale.ready",
  },
} as const;

/**
 * Runtime Set for O(1) event allowlist lookup.
 * Used by EventRouter to gate relay — unknown events are rejected.
 *
 * Adding a new event:
 * 1. Add to RELAY_EVENTS.<domain> above
 * 2. KNOWN_EVENT_SET auto-populates from RELAY_EVENTS
 * 3. Document in docs/Events/Relay/<Domain>/README.md
 */
export const KNOWN_EVENT_SET: ReadonlySet<string> = new Set(
  Object.values(RELAY_EVENTS).flatMap((group) => Object.values(group)),
);
