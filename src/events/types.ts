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
 * Known event types from Laravel
 * Used for type-safe event handling
 */
export const KNOWN_EVENTS = {
  // HIGH Priority
  BALANCE_UPDATED: "balance.updated",
  BADGE_EARNED: "badge.earned",
  REWARD_EARNED: "reward.earned",
  INCOME_TARGET_COMPLETED: "income_target.completed",
  ROOM_LEVEL_UP: "room.level_up",

  // MEDIUM Priority (Agency)
  AGENCY_INVITATION: "agency.invitation",
  AGENCY_JOIN_REQUEST: "agency.join_request",
  AGENCY_JOIN_REQUEST_APPROVED: "agency.join_request_approved",
  AGENCY_JOIN_REQUEST_REJECTED: "agency.join_request_rejected",
  AGENCY_MEMBER_KICKED: "agency.member_kicked",
  AGENCY_DISSOLVED: "agency.dissolved",

  // LOW Priority
  CONFIG_INVALIDATE: "config:invalidate",
} as const;

export type KnownEventType = (typeof KNOWN_EVENTS)[keyof typeof KNOWN_EVENTS];
