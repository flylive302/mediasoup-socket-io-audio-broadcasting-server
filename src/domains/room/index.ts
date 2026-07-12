/**
 * Room Domain - Barrel Export
 */

// Handler registration
export { roomHandler } from "./room.handler.js";

// Room management
export { RoomManager } from "./roomManager.js";

// Block gate mirror (ADR 0017 / room-blocks 03)
export { RoomBlockRepository } from "./room-block.repository.js";

// Auto-close system
export { AutoCloseService, AutoCloseJob } from "./auto-close/index.js";

// Types
export type { RoomState } from "./types.js";
