import type { Socket } from 'socket.io';
import type { AppContext } from '../../context.js';
import { logger } from '../../core/logger.js';
import { joinRoomSchema, leaveRoomSchema } from '../schemas.js';
import { getRoomSeats, clearUserSeat } from './seatHandler.js';

export const roomHandler = (
  socket: Socket,
  context: AppContext
) => {
  const { roomManager, clientManager, laravelClient } = context;

  // JOIN
  socket.on('room:join', async (rawPayload: unknown, ack) => {
    const payloadResult = joinRoomSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
        if (ack) ack({ error: 'Invalid payload' });
        return;
    }
    const { roomId } = payloadResult.data;

    try {
        logger.debug({ socketId: socket.id, roomId }, 'Join request');

        const routerManager = await roomManager.getOrCreateRoom(roomId);
        const rtpCapabilities = routerManager.router?.rtpCapabilities;
        
        // Update Client Data
        const client = clientManager.getClient(socket.id);
        if (client) client.roomId = roomId;

        // Gather current room state BEFORE joining (so we don't include self)
        const existingClients = clientManager.getClientsInRoom(roomId);
        
        // Build participants list
        const participants = existingClients.map(c => ({
          id: c.userId,
          name: c.user.name,
          avatar: c.user.avatar,
          isSpeaker: c.isSpeaker,
        }));

        // Build seats list from seat handler state
        const roomSeats = getRoomSeats(roomId);
        const seats: { seatIndex: number; userId: string; isMuted: boolean }[] = [];
        if (roomSeats) {
          for (const [seatIndex, seatData] of roomSeats) {
            seats.push({
              seatIndex,
              userId: seatData.userId,
              isMuted: seatData.muted,
            });
          }
        }

        // Build existing producers list (for audio consumption)
        const existingProducers: { producerId: string; userId: number }[] = [];
        for (const c of existingClients) {
          // Get audio producer if exists
          const audioProducerId = c.producers.get('audio');
          if (audioProducerId) {
            existingProducers.push({
              producerId: audioProducerId,
              userId: c.userId,
            });
          }
        }

        socket.join(roomId);
        
        // Update participant count in Redis and notify Laravel
        const newCount = await roomManager.state.adjustParticipantCount(roomId, 1);
        if (newCount !== null) {
            await laravelClient.updateRoomStatus(roomId, {
                is_live: true,
                participant_count: newCount
            });
        }
        
        // Notify others
        socket.to(roomId).emit('room:userJoined', {
            userId: socket.data.user.id,
            user: socket.data.user
        });
        
        logger.debug({ 
          roomId, 
          participantCount: participants.length,
          seatCount: seats.length,
          producerCount: existingProducers.length 
        }, 'Sending initial room state');
        
        if (ack) ack({ 
          rtpCapabilities,
          participants,
          seats,
          existingProducers,
        });

    } catch (err: unknown) {
        logger.error({ err }, 'Failed to join room');
        if (ack) ack({ error: 'Internal error' });
    }
  });

  // LEAVE
  socket.on('room:leave', async (rawPayload: unknown) => {
    const payloadResult = leaveRoomSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      return; // Silently ignore invalid leave requests
    }
    const { roomId } = payloadResult.data;
    const userId = String(socket.data.user.id);

    // Clear user's seat if seated
    const clearedSeatIndex = clearUserSeat(roomId, userId);
    if (clearedSeatIndex !== null) {
      socket.to(roomId).emit('seat:cleared', { seatIndex: clearedSeatIndex });
      logger.debug({ roomId, userId, seatIndex: clearedSeatIndex }, 'User seat cleared on leave');
    }

    socket.leave(roomId);
    
    // Update participant count in Redis and notify Laravel
    const newCount = await roomManager.state.adjustParticipantCount(roomId, -1);
    if (newCount !== null) {
        await laravelClient.updateRoomStatus(roomId, {
            is_live: newCount > 0,
            participant_count: newCount
        });
    }
    
    // Notify others
    socket.to(roomId).emit('room:userLeft', { userId: socket.data.user.id });
  });
};
