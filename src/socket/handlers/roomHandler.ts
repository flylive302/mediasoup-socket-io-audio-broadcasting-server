import type { Socket } from "socket.io";
import type { AppContext } from "../../context.js";
import { logger } from "../../core/logger.js";
import { joinRoomSchema, leaveRoomSchema } from "../schemas.js";
import { setRoomOwner } from "../../seat/index.js";
import { config } from "../../config/index.js";
import { AuthenticatedUser, SeatUser } from "../../types.js";

export const roomHandler = (socket: Socket, context: AppContext) => {
  const {
    io,
    roomManager,
    clientManager,
    laravelClient,
    autoCloseService,
    seatRepository,
    userSocketRepository,
  } = context;

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

      // Track user's current room in Redis (for user:getRoom feature)
      const userId = socket.data.user.id;
      await userSocketRepository.setUserRoom(userId, roomId);

      // Gather current room state BEFORE joining (so we don't include self for notifications,
      // but we DO include everything in the initial state payload for the joiner)

      // Helper to get participants (excluding self for initial state)
      // Also verifies each socket is still connected to filter stale entries
      const getParticipants = async (roomId: string) => {
        const existingClients = clientManager.getClientsInRoom(roomId);
        const verifiedParticipants = [];
        
        for (const c of existingClients) {
          if (c.socketId === socket.id) continue; // Exclude self
          
          // Verify socket is still connected
          const clientSocket = io.sockets.sockets.get(c.socketId);
          if (!clientSocket?.connected) {
            // Stale client - remove from clientManager
            logger.warn({ socketId: c.socketId, userId: c.userId, roomId }, "Removing stale client");
            clientManager.removeClient(c.socketId);
            continue;
          }
          
          verifiedParticipants.push({
            // MinimalUser fields
            id: c.userId,
            name: c.user.name,
            signature: c.user.signature,
            avatar: c.user.avatar,
            gender: c.user.gender,
            country: c.user.country,
            phone: c.user.phone,
            email: c.user.email,
            date_of_birth: c.user.date_of_birth,
            wealth_xp: c.user.economy.wealth_xp,
            charm_xp: c.user.economy.charm_xp,
            // Room-specific fields
            isSpeaker: c.isSpeaker,
          });
        }
        
        return verifiedParticipants;
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

      // Get initial state using Redis-backed seatRepository
      const participants = await getParticipants(roomId);
      const [roomSeatsData, lockedSeats] = await Promise.all([
        seatRepository.getSeats(roomId, config.DEFAULT_SEAT_COUNT),
        seatRepository.getLockedSeats(roomId),
      ]);
      const existingProducers = await getProducers(roomId);

      // Transform seats to array with full user data
      // Frontend expects same format as seat:updated events: { seatIndex, user: SeatUser, isMuted }
      const seats: {
        seatIndex: number;
        user: SeatUser | null;
        isMuted: boolean;
      }[] = [];
      for (const seatData of roomSeatsData) {
        if (seatData.userId) {
          // Find the user in the room to get their full data
          const seatedClient = clientManager
            .getClientsInRoom(roomId)
            .find((c) => String(c.userId) === seatData.userId);

          if (seatedClient) {
            seats.push({
              seatIndex: seatData.index,
              user: {
                id: seatedClient.userId,
                name: seatedClient.user.name,
                avatar: seatedClient.user.avatar,
                signature: seatedClient.user.signature,
                gender: seatedClient.user.gender,
                country: seatedClient.user.country,
                phone: seatedClient.user.phone,
                email: seatedClient.user.email,
                date_of_birth: seatedClient.user.date_of_birth,
                wealth_xp: seatedClient.user.economy.wealth_xp,
                charm_xp: seatedClient.user.economy.charm_xp,
              },
              isMuted: seatData.muted,
            });
          } else {
            // User might have disconnected but seat not cleared yet
            seats.push({
              seatIndex: seatData.index,
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

    // Clear user's seat if seated (using Redis)
    const result = await seatRepository.leaveSeat(roomId, userId);
    if (result.success && result.seatIndex !== undefined) {
      socket.to(roomId).emit("seat:cleared", { seatIndex: result.seatIndex });
      logger.debug(
        { roomId, userId, seatIndex: result.seatIndex },
        "User seat cleared on leave",
      );
    }

    socket.leave(roomId);

    // Clear user's room tracking in Redis
    await userSocketRepository.clearUserRoom(socket.data.user.id);

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
