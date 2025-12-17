import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { joinRoomSchema, leaveRoomSchema } from "../schemas.js";
import {
  getRoomSeats,
  clearUserSeat,
  setRoomOwner,
  getLockedSeats,
} from "../../seat/index.js";

export const roomHandler = (socket: Socket, context: AppContext) => {
  const { roomManager, clientManager, laravelClient, autoCloseService } = context;

  // JOIN
  socket.on("room:join", async (rawPayload: unknown, ack) => {
    const payloadResult = joinRoomSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (ack) ack({ error: "Invalid payload" });
      return;
    }
    const { roomId } = payloadResult.data;

    try {
      logger.debug({ socketId: socket.id, roomId }, "Join request");

      const routerManager = await roomManager.getOrCreateRoom(roomId);
      const rtpCapabilities = routerManager.router?.rtpCapabilities;

      // Cache room owner if provided by frontend
      const { ownerId } = payloadResult.data;
      if (ownerId) {
        setRoomOwner(roomId, String(ownerId));
        logger.debug({ roomId, ownerId }, "Room owner set from frontend");
      }

      // Update Client Data
      const client = clientManager.getClient(socket.id);
      if (client) client.roomId = roomId;

      // Gather current room state BEFORE joining (so we don't include self for notifications,
      // but we DO include everything in the initial state payload for the joiner)

      const userId = socket.data.user.id;

      // Helper to get participants (excluding self for initial state)
      const getParticipants = async (roomId: string) => {
        const existingClients = clientManager.getClientsInRoom(roomId);
        return existingClients
          .filter((c) => c.socketId !== socket.id) // Exclude self
          .map((c) => ({
            id: c.userId,
            name: c.user.name,
            avatar: c.user.avatar,
            isSpeaker: c.isSpeaker,
          }));
      };

      // Helper to get producers (excluding self for initial state)
      const getProducers = async (roomId: string) => {
        const existingClients = clientManager.getClientsInRoom(roomId);
        const producers: { producerId: string; userId: number }[] = [];
        for (const c of existingClients) {
          if (c.socketId === socket.id) continue; // Exclude self
          const audioProducerId = c.producers.get("audio");
          if (audioProducerId) {
            producers.push({
              producerId: audioProducerId,
              userId: c.userId,
            });
          }
        }
        return producers;
      };

      // Get initial state using imported handlers
      const participants = await getParticipants(roomId);
      const roomSeats = getRoomSeats(roomId);
      const existingProducers = await getProducers(roomId);
      const lockedSeats = getLockedSeats(roomId);

      // Transform seats map to array with full user data
      // Frontend expects same format as seat:updated events: { seatIndex, user: {id, name, avatar}, isMuted }
      const seats: { seatIndex: number; user: { id: string | number; name?: string; avatar?: string } | null; isMuted: boolean }[] =
        [];
      if (roomSeats) {
        for (const [seatIndex, seatData] of roomSeats) {
          // Find the user in the room to get their full data
          const seatedClient = clientManager
            .getClientsInRoom(roomId)
            .find((c) => String(c.userId) === seatData.userId);
          
          if (seatedClient) {
            seats.push({
              seatIndex,
              user: {
                id: seatedClient.userId,
                name: seatedClient.user.name,
                avatar: seatedClient.user.avatar,
              },
              isMuted: seatData.muted,
            });
          } else {
            // User might have disconnected but seat not cleared yet
            seats.push({
              seatIndex,
              user: { id: seatData.userId },
              isMuted: seatData.muted,
            });
          }
        }
      }

      socket.join(roomId);

      // Record activity to prevent auto-close
      await autoCloseService.recordActivity(roomId);

      // Update participant count in Redis and notify Laravel
      const newCount = await roomManager.state.adjustParticipantCount(
        roomId,
        1,
      );
      if (newCount !== null) {
        await laravelClient.updateRoomStatus(roomId, {
          is_live: true,
          participant_count: newCount,
        });
      }

      // Notify others
      socket.to(roomId).emit("room:userJoined", {
        userId: socket.data.user.id,
        user: socket.data.user,
      });

      logger.info(
        {
          roomId,
          userId,
          participantCount: participants.length,
          seatCount: seats.length,
          lockedSeatsCount: lockedSeats.length,
          producerCount: existingProducers.length,
        },
        "Sending initial room state",
      );

      if (ack)
        ack({
          rtpCapabilities,
          participants,
          seats,
          lockedSeats,
          existingProducers,
        });
    } catch (err: unknown) {
      logger.error({ err }, "Failed to join room");
      if (ack) ack({ error: "Internal error" });
    }
  });

  // LEAVE
  socket.on("room:leave", async (rawPayload: unknown) => {
    const payloadResult = leaveRoomSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      return; // Silently ignore invalid leave requests
    }
    const { roomId } = payloadResult.data;
    const userId = String(socket.data.user.id);

    // Clear user's seat if seated
    const clearedSeatIndex = clearUserSeat(roomId, userId);
    if (clearedSeatIndex !== null) {
      socket.to(roomId).emit("seat:cleared", { seatIndex: clearedSeatIndex });
      logger.debug(
        { roomId, userId, seatIndex: clearedSeatIndex },
        "User seat cleared on leave",
      );
    }

    socket.leave(roomId);

    // Update participant count in Redis and notify Laravel
    const newCount = await roomManager.state.adjustParticipantCount(roomId, -1);
    if (newCount !== null) {
      await laravelClient.updateRoomStatus(roomId, {
        is_live: newCount > 0,
        participant_count: newCount,
      });
    }

    // Notify others
    socket.to(roomId).emit("room:userLeft", { userId: socket.data.user.id });
  });
};
