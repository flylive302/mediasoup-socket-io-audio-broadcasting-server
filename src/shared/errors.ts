/**
 * Shared error message constants for consistent error responses
 */
export const Errors = {
  // General
  INVALID_PAYLOAD: "Invalid payload",
  INTERNAL_ERROR: "Internal server error",
  NOT_AUTHORIZED: "Not authorized",
  RATE_LIMITED: "Too many requests",
  CANNOT_GIFT_SELF: "Cannot send gift to yourself",
  RECIPIENT_NOT_SEATED: "Recipient is not seated",

  // Room
  NOT_IN_ROOM: "Not in room",
  ROOM_NOT_FOUND: "Room not found",
  ROOM_CLOSED: "Room is closed",
  MUSIC_ALREADY_PLAYING: "Music is already playing in this room",
  KICK_FAILED: "Failed to kick user",

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
  VIP_PROTECTED: "User is VIP protected",

  // Invite
  INVITE_CREATE_FAILED: "Failed to create invite",
  INVITE_PENDING: "Invite already pending for this seat",
  NO_INVITE: "No pending invite found",
  CANNOT_INVITE_SELF: "Cannot invite yourself",
  SEAT_OCCUPIED: "Seat is already occupied",

  // Media
  TRANSPORT_NOT_FOUND: "Transport not found",
  TRANSPORT_LIMIT: "Transport limit reached",
  CONSUMER_NOT_FOUND: "Consumer not found",
  PRODUCER_NOT_FOUND: "Producer not found",
  NOT_PRODUCER_OWNER: "Not your producer",
  CANNOT_CONSUME: "Cannot consume",

  // Auth
  ORIGIN_NOT_ALLOWED: "Origin not allowed",
  AUTH_REQUIRED: "Authentication required",
  INVALID_CREDENTIALS: "Invalid credentials",
  AUTH_FAILED: "Authentication failed",
  AUTH_CHECK_FAILED: "Authorization check failed",
} as const;

export type ErrorCode = (typeof Errors)[keyof typeof Errors];
