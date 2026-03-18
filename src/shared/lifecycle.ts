/**
 * Domain Lifecycle Interface (LT-5)
 *
 * Domains that need cleanup on socket disconnect implement this interface.
 * The disconnect handler iterates registered lifecycle hooks instead of
 * hard-coding per-domain cleanup logic.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";

/**
 * Client state snapshot provided to lifecycle hooks during disconnect.
 */
export interface DisconnectContext {
  socket: Socket;
  userId: number;
  roomId: string | null;
  reason: string;
}

/**
 * Domain lifecycle interface. Domains can implement any subset of hooks.
 */
export interface DomainLifecycle {
  /** Unique name for logging/debugging */
  readonly name: string;

  /**
   * Called when a socket disconnects.
   * Lifecycle hooks run in parallel for performance.
   * Errors in individual hooks don't affect other hooks.
   */
  onDisconnect(ctx: DisconnectContext, appCtx: AppContext): Promise<void>;
}

/**
 * Global registry of domain lifecycle hooks.
 */
const lifecycleRegistry: DomainLifecycle[] = [];

/**
 * Register a domain lifecycle hook.
 * Called during domain initialization.
 */
export function registerLifecycle(lifecycle: DomainLifecycle): void {
  lifecycleRegistry.push(lifecycle);
}

/**
 * Get all registered lifecycle hooks.
 */
export function getLifecycleHooks(): readonly DomainLifecycle[] {
  return lifecycleRegistry;
}
