/**
 * Audio Player Handler — Room music playback coordination
 *
 * Manages a per-room mutex so only one user can play music at a time.
 * The actual audio stream flows through the existing mediasoup producer
 * pipeline (client produces via Web Audio API → distribution routers).
 * These handlers coordinate metadata and UI state only.
 *
 * The waiting-queue machinery (FIFO enqueue, atomic release+grant, promote,
 * ghost-skip grant chain, grace timer) lives in ./audio-player.queue.ts.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  audioPlayerPlaySchema,
  audioPlayerTakeoverSchema,
  audioPlayerStopSchema,
  audioPlayerStateUpdateSchema,
  audioPlayerLeaveQueueSchema,
} from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom, emitToRoom } from "@src/shared/room-emit.js";
import { Errors } from "@src/shared/errors.js";
import { verifyRoomManager, verifyRoomOwner } from "@src/domains/seat/seat.owner.js";
import {
  musicPlayerKey,
  musicStateKey,
  musicQueueKey,
  MUSIC_PLAYER_TTL_SECONDS,
  enqueueMusicWaiter,
  promoteIfFree,
  releaseAndGrant,
  grantChain,
  hasLiveSocketInRoom,
} from "./audio-player.queue.js";

/**
 * music-dj-queue/01: Stale-proof slot acquisition (atomic).
 *
 * Always returns the RESULTING holder id, so the caller's success test is
 * simply `result === myId`. One script covers three cases:
 *   - free slot (GET null)        → acquire
 *   - reuse-if-mine (GET == myId) → re-SET (refreshes TTL, never MUSIC_ALREADY_PLAYING on track change)
 *   - CAS steal (GET == stealHolder, passed only after a JS liveness check
 *                proved that holder has zero live sockets in the room)
 * Otherwise the current (live, different) holder id is returned unchanged →
 * denial. Passing stealHolder="" disables the steal branch (phase-1 call).
 *
 * Race safety: the steal is a compare-and-set — two admins who both observe the
 * same dead holder cannot both win. The first CAS overwrites the key with its
 * own id; the second sees `cur` = the winner's id (≠ stealHolder, ≠ its own id)
 * and is denied. No check-then-set window exists because the compare and the
 * set are one Redis round-trip inside the script.
 */
const ACQUIRE_MUSIC_SLOT_LUA = `
local cur = redis.call('GET', KEYS[1])
if (not cur) or (cur == ARGV[1]) or (ARGV[2] ~= '' and cur == ARGV[2]) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
  return ARGV[1]
else
  return cur
end
`;

// ─────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────

/**
 * audioPlayer:play — Acquire the music player mutex and broadcast metadata.
 * Only one user per room can play music at a time.
 */
const playHandler = createHandler(
  "audioPlayer:play",
  audioPlayerPlaySchema,
  async (payload, socket, context) => {
    const { roomId, title, duration, enqueue } = payload;
    const userId = socket.data.user.id;

    const client = context.clientManager.getClient(socket.id);
    if (!client?.roomId || client.roomId !== roomId) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // Only the room owner or an admin may start music playback
    const authorization = await verifyRoomManager(roomId, String(userId), context);
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }

    // Acquire mutex — stale-proof (music-dj-queue/01): free slot, reuse-if-mine
    // (refreshes TTL so track changes never self-deny), or steal a dead holder's
    // slot (holder with zero live sockets in this room). Only a live, different
    // holder denies.
    let acquired = await acquireMusicSlot(context, roomId, userId);
    if (!acquired) {
      // music-dj-queue/04: OTA compat — bundles that don't opt in get today's
      // exact behavior (no queue write, plain MUSIC_ALREADY_PLAYING).
      if (!enqueue) {
        return { success: false, error: Errors.MUSIC_ALREADY_PLAYING };
      }

      // EXECUTE — enqueue behind the live DJ (idempotent), then close the
      // release-between-denial-and-enqueue race: if the slot went free, promote
      // the head. If that head is me I actually got the slot; if it is a
      // different waiter, grant them; otherwise return my queued ack.
      const position = await enqueueMusicWaiter(context.redis, roomId, userId);
      const promoted = await promoteIfFree(context.redis, roomId);
      if (promoted === String(userId)) {
        // Won the freed slot — the promote SET only the provisional grace TTL, so
        // refresh to the full crash-backstop TTL (reuse-if-mine) before falling
        // through to the normal success path. The reacquire can still lose to an
        // owner takeover landing between the two calls (takeover force-overwrites
        // the key), so a false here MUST deny — falling through would broadcast
        // "playing" for a user who no longer holds the mutex.
        acquired = await acquireMusicSlot(context, roomId, userId);
        if (!acquired) {
          return { success: false, error: Errors.MUSIC_ALREADY_PLAYING };
        }
      } else {
        // music-dj-queue/05: a different head was promoted in the race window —
        // grant it through the ghost-skip chain (the head may itself be dead).
        if (promoted && promoted !== String(userId)) {
          await grantChain(context.io, context.redis, roomId, promoted, context.clientManager);
        }
        return { success: false, error: Errors.MUSIC_ALREADY_PLAYING, queued: true, position };
      }
    }

    // Store music state in Redis for new joiners
    const state = JSON.stringify({
      userId,
      title,
      duration,
      startedAt: Date.now(),
      isPaused: false,
      position: 0,
    });
    await context.redis.setex(musicStateKey(roomId), MUSIC_PLAYER_TTL_SECONDS, state);

    // Broadcast to all room members (including sender for UI confirmation)
    broadcastToRoom(
      context.io,
      roomId,
      "audioPlayer:stateChanged",
      {
        state: "playing",
        userId,
        title,
        duration,
        position: 0,
      },
      context.cascadeRelay,
    );

    logger.info(
      { roomId, userId, title, duration },
      "Audio player started",
    );

    return { success: true };
  },
);

/**
 * audioPlayer:takeover — Owner force-takes a live music slot (ADR-0006).
 *
 * Owner-only (`verifyRoomOwner`): non-owner admins are rejected and the current
 * DJ keeps playing. On success the mutex is force-reassigned to the owner, a
 * **targeted** `audioPlayer:revoked` is emitted to the displaced DJ's socket(s)
 * in this room only (so the Room never hears two tracks), and the normal
 * `audioPlayer:stateChanged` is broadcast. The waiting queue is preserved behind
 * the owner (never popped here) — waiters are granted when the owner releases.
 */
const takeoverHandler = createHandler(
  "audioPlayer:takeover",
  audioPlayerTakeoverSchema,
  async (payload, socket, context) => {
    const { roomId, title, duration } = payload;
    const userId = socket.data.user.id;

    const client = context.clientManager.getClient(socket.id);
    if (!client?.roomId || client.roomId !== roomId) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // Owner-only — admins cannot interrupt a live DJ (kept distinct from the
    // permissive verifyRoomManager tier; see SEAT-012).
    const authorization = await verifyRoomOwner(roomId, String(userId), context);
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }

    // Identify the displaced DJ (if any) BEFORE overwriting the mutex.
    const displaced = await context.redis.get(musicPlayerKey(roomId));

    // Force-overwrite the mutex (no NX) — reassign the slot to the owner.
    await context.redis.set(
      musicPlayerKey(roomId),
      String(userId),
      "EX",
      MUSIC_PLAYER_TTL_SECONDS,
    );

    const state = JSON.stringify({
      userId,
      title,
      duration,
      startedAt: Date.now(),
      isPaused: false,
      position: 0,
    });
    await context.redis.setex(musicStateKey(roomId), MUSIC_PLAYER_TTL_SECONDS, state);

    // Targeted revoke to the displaced DJ's socket(s) in THIS room only — never
    // the whole Room. This is what stops the displaced stream so there is no
    // overlap; their local queue is preserved for resume.
    if (displaced && displaced !== String(userId)) {
      const socketIds = context.clientManager.getSocketIdsByUserInRoom(
        Number(displaced),
        roomId,
      );
      if (socketIds.length > 0) {
        context.io.to(socketIds).emit("audioPlayer:revoked", { roomId, byUserId: userId });
      }
    }

    // Broadcast the new now-playing to everyone (incl. owner for UI confirmation).
    broadcastToRoom(
      context.io,
      roomId,
      "audioPlayer:stateChanged",
      {
        state: "playing",
        userId,
        title,
        duration,
        position: 0,
      },
      context.cascadeRelay,
    );

    logger.info({ roomId, userId, displaced }, "Audio player force-taken by owner");

    return { success: true };
  },
);

/**
 * audioPlayer:stop — Release the music player mutex and broadcast stop.
 * Only the current music player can stop (or disconnect cleanup).
 */
const stopHandler = createHandler(
  "audioPlayer:stop",
  audioPlayerStopSchema,
  async (payload, socket, context) => {
    const { roomId } = payload;
    const userId = socket.data.user.id;

    // music-dj-queue/04: release + grant the queue head atomically. A non-holder
    // is denied (strict no-op, exactly today's NOT_AUTHORIZED). On release the
    // freed slot is handed to the queue head (provisional grace TTL) inside Lua.
    const [status, head] = await releaseAndGrant(context.redis, roomId, String(userId));
    if (status === "denied") {
      return { success: false, error: Errors.NOT_AUTHORIZED };
    }

    // Broadcast stop to all room members
    broadcastToRoom(
      context.io,
      roomId,
      "audioPlayer:stateChanged",
      {
        state: "stopped",
        userId,
        title: null,
        duration: 0,
        position: 0,
      },
      context.cascadeRelay,
    );

    // EXECUTE (release contract, not fire-and-forget): grant the head their turn.
    // music-dj-queue/05: grantChain skips ghost heads and arms the grace timer.
    if (head) {
      await grantChain(context.io, context.redis, roomId, head, context.clientManager);
    }

    logger.info({ roomId, userId, granted: head || null }, "Audio player stopped");

    return { success: true };
  },
);

/**
 * audioPlayer:stateUpdate — Relay playback progress to room.
 * Sent periodically (~every 2s) by the music player client for UI sync.
 */
const stateUpdateHandler = createHandler(
  "audioPlayer:stateUpdate",
  audioPlayerStateUpdateSchema,
  async (payload, socket, context) => {
    const { roomId, position, isPaused } = payload;
    const userId = socket.data.user.id;

    // Verify this user is the current music player
    const currentPlayer = await context.redis.get(musicPlayerKey(roomId));
    if (currentPlayer !== String(userId)) {
      return { success: false, error: Errors.NOT_AUTHORIZED };
    }

    // Update Redis state for new joiners
    const stateRaw = await context.redis.get(musicStateKey(roomId));
    if (stateRaw) {
      const state = JSON.parse(stateRaw) as Record<string, unknown>;
      state.position = position;
      state.isPaused = isPaused;
      await context.redis.setex(musicStateKey(roomId), MUSIC_PLAYER_TTL_SECONDS, JSON.stringify(state));
    }

    // V-4 FIX: Use cascade-aware emit so cross-region users see playback updates
    emitToRoom(socket, roomId, "audioPlayer:stateChanged", {
      state: isPaused ? "paused" : "playing",
      userId,
      position,
    }, context.cascadeRelay);

    return { success: true };
  },
);

/**
 * audioPlayer:leaveQueue — Cancel a waiting-queue spot (music-dj-queue/05).
 *
 * Removing yourself is always allowed, so there is no GATE beyond the schema and
 * the standard in-room check (matches playHandler). EXECUTE is a single LREM —
 * single-command atomicity suffices, no Lua. Idempotent: a not-queued user acks
 * `removed: false`. Emitted by the client when it presses stop/close or leaves
 * the room while waiting; a disconnect while waiting is handled in the lifecycle.
 */
const leaveQueueHandler = createHandler(
  "audioPlayer:leaveQueue",
  audioPlayerLeaveQueueSchema,
  async (payload, socket, context) => {
    const { roomId } = payload;
    const userId = socket.data.user.id;

    const client = context.clientManager.getClient(socket.id);
    if (!client?.roomId || client.roomId !== roomId) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    const removed = await context.redis.lrem(musicQueueKey(roomId), 0, String(userId));

    return { success: true, removed: removed > 0 };
  },
);

// ─────────────────────────────────────────────────────────────────
// Stage helpers
// ─────────────────────────────────────────────────────────────────

/**
 * music-dj-queue/01: fleet-wide liveness — does `userId` still have a live
 * socket in `roomId` (optionally excluding one socket id)? Thin AppContext-shaped
 * wrapper over {@link hasLiveSocketInRoom} (queue module) so ticket-01 call sites
 * (acquireMusicSlot, the disconnect lifecycle guard) keep their signature.
 *
 * clientManager is instance-local, so a local hit is authoritative ("live") but
 * a local miss is not — the user may hold a socket on another MSAB instance
 * (this room's members can be spread across the fleet via @socket.io/redis-adapter).
 * The wrapped helper consults the adapter through `fetchSocketsSafe` on a miss.
 */
export async function userHasLiveSocketInRoom(
  context: AppContext,
  userId: number,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  return hasLiveSocketInRoom(context.io, context.clientManager, userId, roomId, excludeSocketId);
}

/**
 * music-dj-queue/01: acquire the room's music slot, stale-proof.
 *
 * Phase 1 (atomic): free-slot OR reuse-if-mine. Returns the resulting holder.
 * Phase 2 (only when denied by a DIFFERENT holder): check fleet-wide liveness
 * via `userHasLiveSocketInRoom` (local clientManager fast-path, then the
 * Socket.IO adapter cross-instance). If the holder has no live socket in the
 * room anywhere, CAS-steal the slot. A live different holder is the only denial.
 */
async function acquireMusicSlot(
  context: AppContext,
  roomId: string,
  userId: number,
): Promise<boolean> {
  const key = musicPlayerKey(roomId);
  const me = String(userId);
  const ttl = String(MUSIC_PLAYER_TTL_SECONDS);

  // Phase 1 — free slot or reuse-if-mine (steal branch disabled with "").
  const holder = (await context.redis.eval(
    ACQUIRE_MUSIC_SLOT_LUA,
    1,
    key,
    me,
    "",
    ttl,
  )) as string;
  if (holder === me) return true;

  // Denied by a different holder — steal only if they have no live socket in the
  // room ANYWHERE in the fleet (this room's users can sit on other MSAB
  // instances behind the LB). Local check first, then cross-instance.
  if (await userHasLiveSocketInRoom(context, Number(holder), roomId)) return false;

  // Phase 2 — CAS steal: succeeds only if `holder` is STILL the dead holder.
  const stolen = (await context.redis.eval(
    ACQUIRE_MUSIC_SLOT_LUA,
    1,
    key,
    me,
    holder,
    ttl,
  )) as string;
  return stolen === me;
}

// ─────────────────────────────────────────────────────────────────
// Cleanup on disconnect/leave — exported for use in socket/index.ts
// ─────────────────────────────────────────────────────────────────

/**
 * Release the room's music mutex + broadcast stop, but ONLY if `userId` is
 * the current music player — a no-op otherwise (dj-talk-over/02: kicking a
 * non-DJ must never touch the room's music).
 *
 * Shared by every user-removal path that must make music die with its DJ:
 * disconnect (via audioPlayerLifecycle), kick/eject (ejectRoomMember),
 * seat:lock, and shrink-eviction. One release+broadcast implementation, no
 * per-caller duplication.
 */
export async function releaseMusicPlayerForUser(
  redis: import("ioredis").Redis,
  io: import("socket.io").Server,
  roomId: string,
  userId: number,
  cascadeRelay: import("@src/domains/cascade/cascade-relay.js").CascadeRelay | null,
): Promise<void> {
  // music-dj-queue/04: same atomic release+grant as stopHandler. A non-holder
  // stays a strict no-op ('denied' → return), so kicking/evicting a non-DJ never
  // touches the room's music (dj-talk-over/02). On release the head is granted.
  const [status, head] = await releaseAndGrant(redis, roomId, String(userId));
  if (status === "denied") return;

  broadcastToRoom(
    io,
    roomId,
    "audioPlayer:stateChanged",
    {
      state: "stopped",
      userId,
      title: null,
      duration: 0,
      position: 0,
    },
    cascadeRelay,
  );

  // Grant the head their turn. No clientManager in this helper's signature, so
  // targeting is fetchSocketsSafe-only (fleet-wide via the redis adapter) — see
  // grantChain / hasLiveSocketInRoom. Part of the release EXECUTE contract, so it
  // is awaited. music-dj-queue/05: the chain skips ghost heads and arms the timer.
  if (head) {
    await grantChain(io, redis, roomId, head);
  }

  logger.info({ roomId, userId, granted: head || null }, "Audio player cleared on user removal");
}

/**
 * Get the current music player state for a room.
 * Used by room:join to include music state in the initial ack.
 */
export async function getMusicPlayerState(
  redis: import("ioredis").Redis,
  roomId: string,
): Promise<{
  userId: number;
  title: string;
  duration: number;
  position: number;
  isPaused: boolean;
} | null> {
  const stateRaw = await redis.get(musicStateKey(roomId));
  if (!stateRaw) return null;

  try {
    const state = JSON.parse(stateRaw) as {
      userId: number;
      title: string;
      duration: number;
      startedAt: number;
      position: number;
      isPaused: boolean;
    };
    return {
      userId: state.userId,
      title: state.title,
      duration: state.duration,
      position: state.position,
      isPaused: state.isPaused,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Export: Register all audio player handlers on a socket
// ─────────────────────────────────────────────────────────────────

export const audioPlayerHandler = (socket: Socket, context: AppContext) => {
  socket.on("audioPlayer:play", playHandler(socket, context));
  socket.on("audioPlayer:takeover", takeoverHandler(socket, context));
  socket.on("audioPlayer:stop", stopHandler(socket, context));
  socket.on("audioPlayer:stateUpdate", stateUpdateHandler(socket, context));
  socket.on("audioPlayer:leaveQueue", leaveQueueHandler(socket, context));
};
