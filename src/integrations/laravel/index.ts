/**
 * Laravel Integration - Barrel Export
 * Handles communication with Laravel backend via Redis pub/sub
 */

// Event subscriber for Laravel events
export { LaravelEventSubscriber } from "./event-subscriber.js";

// Event router for dispatching events to sockets
export { EventRouter } from "./event-router.js";

// User socket mapping repository
export { UserSocketRepository } from "./user-socket.repository.js";

// User room tracking repository (RL-015 SRP extraction)
export { UserRoomRepository } from "./user-room.repository.js";

// Types
export type {
  LaravelEvent,
  EventTarget,
  EventRoutingResult,
} from "./types.js";

// Event constants (domain-grouped) and allowlist
export { RELAY_EVENTS, KNOWN_EVENT_SET } from "./types.js";
