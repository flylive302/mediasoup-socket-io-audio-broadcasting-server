/**
 * seat:take - User takes an available seat
 */
import { seatTakeSchema } from "@src/socket/schemas.js";
import { createHandler } from "@src/shared/handler.utils.js";
import { emitToRoom } from "@src/shared/room-emit.js";
import { fetchSocketsSafe } from "@src/shared/fetch-sockets-safe.js";
import { Errors } from "@src/shared/errors.js";
import { config } from "@src/config/index.js";
import { logger } from "@src/infrastructure/logger.js";
import type { AppContext } from "@src/context.js";

export const takeSeatHandler = createHandler(
  "seat:take",
  seatTakeSchema,
  async (payload, socket, context) => {
    const userId = String(socket.data.user.id);
    const { roomId, seatIndex } = payload;

    // SEAT-009: Use actual per-room seatCount from state
    const roomState = await context.roomManager.state.get(roomId);
    const seatCount = roomState?.seatCount ?? config.DEFAULT_SEAT_COUNT;

    // Use atomic Redis operation for horizontal scaling safety
    const result = await context.seatRepository.takeSeat(
      roomId,
      userId,
      seatIndex,
      seatCount,
    );

    if (!result.success) {
      if (result.error === Errors.SEAT_TAKEN) {
        // Seat-desync self-heal: a client whose local view wrongly shows this
        // seat empty (missed seat:updated, grace-window snapshot skew) has no
        // other signal to correct itself — there is no periodic seat resync.
        // Carry the authoritative occupant back on the rejection so the client
        // repairs the one seat it provably disagrees about.
        return {
          success: false,
          error: result.error,
          occupant: await resolveOccupant(roomId, seatIndex, seatCount, context),
        };
      }
      return { success: false, error: result.error };
    }

    logger.info({ roomId, userId, seatIndex, clearedSeatIndices: result.clearedSeatIndices ?? [] }, "User took seat");

    // When the user moved seats (or had orphaned ghost seats from a prior
    // reverse-index desync), tell other clients to clear every prior slot
    // first. Without this, observers would see the user occupying multiple
    // seats until some unrelated event repaints the source. (F-41)
    for (const clearedIndex of result.clearedSeatIndices ?? []) {
      emitToRoom(socket, roomId, "seat:cleared", {
        seatIndex: clearedIndex,
        userId: socket.data.user.id,
      }, context.cascadeRelay);
    }

    // BL-007 FIX: userId-only — frontend looks up user from participants (cascade-aware)
    emitToRoom(socket, roomId, "seat:updated", {
      seatIndex,
      userId: socket.data.user.id,
      isMuted: false,
    }, context.cascadeRelay);

    // BL-001 FIX: Record room activity to prevent auto-close during seat actions
    context.autoCloseService
      .recordActivity(roomId)
      .catch((err) => logger.warn({ err, roomId, userId }, "Failed to record seat activity"));

    return { success: true };
  },
);

// ── Stage helpers ────────────────────────────────────────────

/**
 * Resolve the authoritative occupant of a contested seat for the SEAT_TAKEN
 * rejection payload. `user` comes from live room sockets. Reserved
 * (grace-held) seats yield NO occupant — clients correctly render those
 * empty, and re-filling them would recreate the ghost-seat desync.
 */
async function resolveOccupant(
  roomId: string,
  seatIndex: number,
  seatCount: number,
  context: AppContext,
): Promise<{
  seatIndex: number;
  userId: number;
  isMuted: boolean;
  user: Record<string, unknown> | null;
} | null> {
  try {
    const seats = await context.seatRepository.getSeats(roomId, seatCount);
    const seat = seats.find((s) => s.index === seatIndex);
    if (!seat || seat.userId === null) return null;
    // A reserved (grace-held) seat is CORRECTLY rendered empty on clients —
    // don't hand back an occupant, or the client would wrongly re-fill it.
    // The taker just gets the rejection toast; the slot frees via the sweep
    // or re-fills via the occupant's rejoin seat:updated.
    if (seat.reserved) return null;

    const sockets = await fetchSocketsSafe(context.io, roomId, logger);
    const occupantSocket = sockets.find(
      (s) => String(s.data?.user?.id) === seat.userId,
    );
    const u = occupantSocket?.data?.user ?? null;

    return {
      seatIndex,
      userId: Number(seat.userId),
      isMuted: seat.muted,
      user: u
        ? {
            id: u.id,
            name: u.name,
            signature: u.signature,
            avatar: u.avatar,
            frame_id: u.frame_id,
            chat_bubble_id: u.chat_bubble_id,
            entry_animation_id: u.entry_animation_id,
            data_card_id: u.data_card_id,
            mice_wave_id: u.mice_wave_id,
            slides_id: u.slides_id,
            gender: u.gender,
            country: u.country,
            wealth_xp: u.wealth_xp,
            charm_xp: u.charm_xp,
            vip_level: u.vip_level ?? 0,
            date_of_birth: u.date_of_birth ?? null,
            equipped_badges: u.equipped_badges ?? [],
          }
        : null,
    };
  } catch (err) {
    logger.warn({ err, roomId, seatIndex }, "Failed to resolve occupant for SEAT_TAKEN self-heal");
    return null;
  }
}
