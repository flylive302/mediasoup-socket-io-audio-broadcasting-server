/**
 * Room Domain - Barrel Export
 */

// Handler registration
export { roomHandler } from "./room.handler.js";

// Room management
export { RoomManager } from "./roomManager.js";
export { RoomStateRepository } from "./roomState.js";

// Auto-close system
export { AutoCloseService, AutoCloseJob } from "./auto-close/index.js";

// Types
export type { RoomState } from "./types.js";
