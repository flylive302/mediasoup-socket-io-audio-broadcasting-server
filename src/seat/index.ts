/**
 * Seat Domain - Barrel Export
 */

// Handler registration
export { registerSeatHandlers } from "./seat.handler.js";

// Request schemas
export * from "./seat.requests.js";

// Types
export type {
  SeatData,
  SeatAssignment,
  PendingInvite,
  SeatActionResult,
} from "./seat.types.js";

// Owner management (kept from old seat.state.ts)
export { setRoomOwner, clearRoomOwner, verifyRoomOwner } from "./seat.owner.js";

// Repository (for direct access when needed)
export { SeatRepository } from "./seat.repository.js";
