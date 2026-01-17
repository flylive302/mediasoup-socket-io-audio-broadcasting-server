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
  // HIGH Priority - Economy
  BALANCE_UPDATED: "balance.updated",
  REWARD_EARNED: "reward.earned",
  
  // HIGH Priority - Achievement
  BADGE_EARNED: "badge.earned",
  LEVEL_UP: "level.up",
  
  // HIGH Priority - Room
  ROOM_LEVEL_UP: "room.level_up",
  ROOM_PARTICIPANT_COUNT: "room.participant_count",

  // HIGH Priority - Income
  INCOME_TARGET_COMPLETED: "income_target.completed",
  INCOME_TARGET_MEMBER_COMPLETED: "income_target.member_completed",

  // MEDIUM Priority (Agency)
  AGENCY_INVITATION: "agency.invitation",
  AGENCY_JOIN_REQUEST: "agency.join_request",
  AGENCY_JOIN_REQUEST_APPROVED: "agency.join_request_approved",
  AGENCY_JOIN_REQUEST_REJECTED: "agency.join_request_rejected",
  AGENCY_MEMBER_KICKED: "agency.member_kicked",
  AGENCY_MEMBER_JOINED: "agency.member_joined",
  AGENCY_MEMBER_LEFT: "agency.member_left",
  AGENCY_DISSOLVED: "agency.dissolved",

  // LOW Priority - System
  CONFIG_INVALIDATE: "config:invalidate",
  ASSET_INVALIDATE: "asset:invalidate",
} as const;

export type KnownEventType = (typeof KNOWN_EVENTS)[keyof typeof KNOWN_EVENTS];
