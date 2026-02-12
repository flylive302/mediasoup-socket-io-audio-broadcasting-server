/**
 * Shared error message constants for consistent error responses
 */
export const Errors = {
  // General
  INVALID_PAYLOAD: "Invalid payload",
  INTERNAL_ERROR: "Internal server error",
  NOT_AUTHORIZED: "Not authorized",
  RATE_LIMITED: "Too many requests",

  // Room
  ROOM_NOT_FOUND: "Room not found",
  ROOM_CLOSED: "Room is closed",

  // Seat
  SEAT_TAKEN: "Seat is already taken",
  SEAT_LOCKED: "Seat is locked",
  SEAT_NOT_LOCKED: "Seat is not locked",
  SEAT_ALREADY_LOCKED: "Seat is already locked",
  SEAT_INVALID: "Invalid seat index",
  NOT_SEATED: "You are not seated",
  USER_NOT_SEATED: "User is not seated",

  MUTE_FAILED: "Failed to mute user",
  UNMUTE_FAILED: "Failed to unmute user",

  // Invite
  INVITE_CREATE_FAILED: "Failed to create invite",
  INVITE_PENDING: "Invite already pending for this seat",
  NO_INVITE: "No pending invite found",
  CANNOT_INVITE_SELF: "Cannot invite yourself",
  SEAT_OCCUPIED: "Seat is already occupied",

  // Media
  TRANSPORT_NOT_FOUND: "Transport not found",
  CONSUMER_NOT_FOUND: "Consumer not found",
  PRODUCER_NOT_FOUND: "Producer not found",
  CANNOT_CONSUME: "Cannot consume",

  // Auth
  ORIGIN_NOT_ALLOWED: "Origin not allowed",
  AUTH_REQUIRED: "Authentication required",
  INVALID_CREDENTIALS: "Invalid credentials",
  AUTH_FAILED: "Authentication failed",
  AUTH_CHECK_FAILED: "Authorization check failed",
} as const;

export type ErrorCode = (typeof Errors)[keyof typeof Errors];
