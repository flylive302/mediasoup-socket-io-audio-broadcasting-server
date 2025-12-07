import type { Socket } from 'socket.io';
import { logger } from '../core/logger.js';
import { getRedisClient } from '../core/redis.js';
import { SanctumValidator } from './sanctumValidator.js';
import type { AuthSocketData } from './types.js';

export async function authMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
) {
  const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
  
  if (!token) {
    logger.warn({ socketId: socket.id }, 'Connection attempt without token');
    return next(new Error('Authentication required'));
  }

  // Handle "Bearer " prefix if present in header
  const cleanToken = token.replace(/^Bearer\s+/i, '');

  const redis = getRedisClient();
  
  // Note: Revocation check is handled inside SanctumValidator.validate()
  // No need to check here - avoids duplicate Redis round-trip

  const validator = new SanctumValidator(redis, logger);

  try {
      const user = await validator.validate(cleanToken);
      
      if (!user) {
        logger.warn({ socketId: socket.id }, 'Invalid token provided');
        return next(new Error('Invalid credentials'));
      }

      // Attach user to socket
      socket.data = {
        user,
        token: cleanToken,
      } as AuthSocketData;

      logger.info({ socketId: socket.id, userId: user.id }, 'Client authenticated');
      next();
  } catch (err) {
      logger.error({ err, socketId: socket.id }, 'Authentication error');
      next(new Error('Authentication failed'));
  }
}
