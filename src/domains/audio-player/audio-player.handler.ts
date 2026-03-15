/**
 * Audio Player Handler — Room music playback coordination
 *
 * Manages a per-room mutex so only one user can play music at a time.
 * The actual audio stream flows through the existing mediasoup producer
 * pipeline (client produces via Web Audio API → distribution routers).
 * These handlers coordinate metadata and UI state only.
 */
import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import {
  audioPlayerPlaySchema,
  audioPlayerStopSchema,
  audioPlayerStateUpdateSchema,
} from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { Errors } from "@src/shared/errors.js";

// ─────────────────────────────────────────────────────────────────
// Redis key helpers
// ─────────────────────────────────────────────────────────────────

const musicPlayerKey = (roomId: string) => `room:${roomId}:musicPlayer`;
const musicStateKey = (roomId: string) => `room:${roomId}:musicState`;

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
    const { roomId, title, duration } = payload;
    const userId = socket.data.user.id;

    const client = context.clientManager.getClient(socket.id);
    if (!client?.roomId || client.roomId !== roomId) {
      return { success: false, error: Errors.NOT_IN_ROOM };
    }

    // Acquire mutex — only one music player per room
    const acquired = await context.redis.set(
      musicPlayerKey(roomId),
      String(userId),
      "NX",
    );

    if (!acquired) {
      return { success: false, error: Errors.MUSIC_ALREADY_PLAYING };
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
    await context.redis.set(musicStateKey(roomId), state);

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
 * audioPlayer:stop — Release the music player mutex and broadcast stop.
 * Only the current music player can stop (or disconnect cleanup).
 */
const stopHandler = createHandler(
  "audioPlayer:stop",
  audioPlayerStopSchema,
  async (payload, socket, context) => {
    const { roomId } = payload;
    const userId = socket.data.user.id;

    // Verify this user is the current music player
    const currentPlayer = await context.redis.get(musicPlayerKey(roomId));
    if (currentPlayer !== String(userId)) {
      return { success: false, error: Errors.NOT_AUTHORIZED };
    }

    // Release mutex and clear state
    await Promise.all([
      context.redis.del(musicPlayerKey(roomId)),
      context.redis.del(musicStateKey(roomId)),
    ]);

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

    logger.info({ roomId, userId }, "Audio player stopped");

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
      await context.redis.set(musicStateKey(roomId), JSON.stringify(state));
    }

    // Broadcast to room (excluding sender — they already know)
    socket.to(roomId).emit("audioPlayer:stateChanged", {
      state: isPaused ? "paused" : "playing",
      userId,
      position,
    });

    return { success: true };
  },
);

// ─────────────────────────────────────────────────────────────────
// Cleanup on disconnect/leave — exported for use in socket/index.ts
// ─────────────────────────────────────────────────────────────────

/**
 * Clear the music player mutex if the disconnecting user was playing music.
 * Called from the disconnect handler in socket/index.ts.
 */
export async function clearMusicPlayerOnDisconnect(
  redis: import("ioredis").Redis,
  io: import("socket.io").Server,
  roomId: string,
  userId: number,
  cascadeRelay: import("@src/domains/cascade/cascade-relay.js").CascadeRelay | null,
): Promise<void> {
  const currentPlayer = await redis.get(musicPlayerKey(roomId));
  if (currentPlayer !== String(userId)) return;

  await Promise.all([
    redis.del(musicPlayerKey(roomId)),
    redis.del(musicStateKey(roomId)),
  ]);

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

  logger.info({ roomId, userId }, "Audio player cleared on disconnect");
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
  socket.on("audioPlayer:stop", stopHandler(socket, context));
  socket.on("audioPlayer:stateUpdate", stateUpdateHandler(socket, context));
};
