import type { Socket } from "socket.io";
import type { AppContext } from "@src/context.js";
import { logger } from "@src/infrastructure/logger.js";
import { joinRoomSchema, leaveRoomSchema } from "@src/socket/schemas.js";
import { setRoomOwner } from "@src/domains/seat/index.js";
import { Errors } from "@src/shared/errors.js";

export const roomHandler = (socket: Socket, context: AppContext) => {
  const {
    io,
    roomManager,
    clientManager,
    laravelClient,
    autoCloseService,
    seatRepository,
    userRoomRepository,
  } = context;

  // JOIN
  socket.on("room:join", async (rawPayload: unknown, ack) => {
    const payloadResult = joinRoomSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      if (ack) ack({ error: Errors.INVALID_PAYLOAD });
      return;
    }
    const { roomId, seatCount } = payloadResult.data;

    try {
      logger.debug({ socketId: socket.id, roomId }, "Join request");

      const cluster = await roomManager.getOrCreateRoom(roomId);
      const rtpCapabilities = cluster.router?.rtpCapabilities;

      // BL-003 FIX: Persist seatCount from frontend if different from default
      if (seatCount !== 15) {
        const state = await roomManager.state.get(roomId);
        if (state && state.seatCount !== seatCount) {
          state.seatCount = seatCount;
          await roomManager.state.save(state);
        }
      }

      // Cache room owner if provided by frontend
      const { ownerId } = payloadResult.data;
      if (ownerId) {
        setRoomOwner(roomId, String(ownerId));
        logger.debug({ roomId, ownerId }, "Room owner set from frontend");
      }

      // PERF-006: Use setClientRoom to update the room index
      const userId = socket.data.user.id;
      clientManager.setClientRoom(socket.id, roomId);

      // BL-002 FIX: SINGLE call to getClientsInRoom — build all data structures from it
      const allClients = clientManager.getClientsInRoom(roomId);

      const participants: {
        id: number;
        name: string;
        signature: string;
        avatar: string;
        frame: string;
        gender: number;
        country: string;
        phone: string;
        email: string;
        date_of_birth: string;
        wealth_xp: string;
        charm_xp: string;
        isSpeaker: boolean;
      }[] = [];
      const existingProducers: { producerId: string; userId: number }[] = [];

      for (const c of allClients) {
        if (c.socketId === socket.id) continue; // Exclude self

        // Verify socket is still connected
        const clientSocket = io.sockets.sockets.get(c.socketId);
        if (!clientSocket?.connected) {
          // Stale client — remove from clientManager
          logger.warn(
            { socketId: c.socketId, userId: c.userId, roomId },
            "Removing stale client",
          );
          clientManager.removeClient(c.socketId);
          continue;
        }

        participants.push({
          id: c.userId,
          name: c.user.name,
          signature: c.user.signature,
          avatar: c.user.avatar,
          frame: c.user.frame,
          gender: c.user.gender,
          country: c.user.country,
          phone: c.user.phone,
          email: c.user.email,
          date_of_birth: c.user.date_of_birth,
          wealth_xp: c.user.wealth_xp,
          charm_xp: c.user.charm_xp,
          isSpeaker: c.isSpeaker,
        });

        const audioProducerId = c.producers.get("audio");
        if (audioProducerId) {
          existingProducers.push({
            producerId: audioProducerId,
            userId: c.userId,
          });
        }
      }

      // SEAT-BONUS: getSeats already includes locked status — no separate Redis call needed
      const roomSeatsData = await seatRepository.getSeats(roomId, seatCount);
      const lockedSeats = roomSeatsData
        .filter((s) => s.locked)
        .map((s) => s.index);

      // BL-007 FIX: Send userId only — frontend has full user data in participants
      const seats: {
        seatIndex: number;
        userId: number;
        isMuted: boolean;
      }[] = [];
      for (const seatData of roomSeatsData) {
        if (seatData.userId) {
          seats.push({
            seatIndex: seatData.index,
            userId: Number(seatData.userId),
            isMuted: seatData.muted,
          });
        }
      }

      socket.join(roomId);

      // BL-001 FIX: Parallelize Redis ops — don't block ack on sequential awaits
      const [newCount] = await Promise.all([
        roomManager.state.adjustParticipantCount(roomId, 1),
        autoCloseService.recordActivity(roomId),
        userRoomRepository.setUserRoom(userId, roomId),
      ]);

      // BL-001 FIX: Laravel update is fire-and-forget — don't make user wait
      if (newCount !== null) {
        laravelClient
          .updateRoomStatus(roomId, {
            is_live: true,
            participant_count: newCount,
          })
          .catch((err) =>
            logger.error({ err, roomId }, "Laravel status update failed"),
          );
      }

      // BL-007 FIX: Include full user data so existing members can update participants store
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
      if (ack) ack({ error: Errors.INTERNAL_ERROR });
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

    // ROOM-BL-002 FIX: Clear client from room index to prevent ghost entries
    clientManager.clearClientRoom(socket.id);

    // BL-001 FIX: Parallelize Redis cleanup and fire-and-forget Laravel
    const [newCount] = await Promise.all([
      roomManager.state.adjustParticipantCount(roomId, -1),
      userRoomRepository.clearUserRoom(socket.data.user.id),
      autoCloseService.recordActivity(roomId),
    ]);

    // Laravel update is fire-and-forget
    if (newCount !== null) {
      laravelClient
        .updateRoomStatus(roomId, {
          is_live: newCount > 0,
          participant_count: newCount,
        })
        .catch((err) =>
          logger.error({ err, roomId }, "Laravel leave status update failed"),
        );
    }

    // Notify others
    socket.to(roomId).emit("room:userLeft", { userId: socket.data.user.id });
  });
};
