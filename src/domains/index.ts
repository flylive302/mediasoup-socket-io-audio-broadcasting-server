/**
 * Domain Registry - Static registration for zero runtime overhead
 * 
 * To add a domain: Import and add to domains array
 * To remove a domain: Remove import and entry from array
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";

// Domain registration function type
export type DomainRegistration = (socket: Socket, ctx: AppContext) => void;

// Import domain handlers
import { registerSeatHandlers } from "./seat/index.js";
import { roomHandler } from "./room/room.handler.js";
import { mediaHandler } from "./media/media.handler.js";
import { chatHandler } from "./chat/index.js";
import { userHandler } from "./user/user.handler.js";

/**
 * All registered domains - order may matter for initialization
 */
export const domains: DomainRegistration[] = [
  registerSeatHandlers,
  roomHandler,
  mediaHandler,
  chatHandler,
  userHandler,
] as const;

/**
 * Register all domain handlers for a socket connection
 */
export function registerAllDomains(socket: Socket, ctx: AppContext): void {
  for (const register of domains) {
    register(socket, ctx);
  }
}
