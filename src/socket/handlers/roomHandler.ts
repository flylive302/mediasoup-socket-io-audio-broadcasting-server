import type { Socket } from 'socket.io';
import type { AppContext } from '../../context.js';
import { logger } from '../../core/logger.js';
import { joinRoomSchema, leaveRoomSchema } from '../schemas.js';

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
        
        if (ack) ack({ rtpCapabilities });

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
