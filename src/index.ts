import { logger } from './core/logger.js';
import { config } from './config/index.js';
import { bootstrapServer } from './core/server.js';
import { getRedisClient } from './core/redis.js';

const start = async () => {
  try {
    // Validate config and connect to Redis early
    getRedisClient();

    const { server, io, workerManager, giftHandler } = await bootstrapServer();

    const address = await server.listen({ 
      port: config.PORT, 
      host: '0.0.0.0' 
    });

    logger.info(`Server listening at ${address}`);
    logger.info(`Environment: ${config.NODE_ENV}`);

    // Graceful Shutdown Logic
    let isShuttingDown = false;

    const gracefulShutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      
      logger.info({ signal }, 'Graceful shutdown initiated');
      
      const timeoutMs = 30_000;
      const shutdownTimeout = setTimeout(() => {
        logger.error('Shutdown timeout exceeded, forcing exit');
        process.exit(1);
      }, timeoutMs);
      
      try {
        // 1. Close Socket.IO (disconnect clients)
        io.close();
        
        // 2. Stop gift buffer processing
        if (giftHandler) {
            await giftHandler.stop();
        }
        
        // 3. Shutdown mediasoup workers
        await workerManager.shutdown();
        
        // 4. Close Redis
        const redis = getRedisClient();
        if (redis.status === 'ready') {
          await redis.quit();
        }
        
        // 5. Close Fastify
        await server.close();
        
        clearTimeout(shutdownTimeout);
        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

// Handle unhandled rejections
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled Rejection');
  process.exit(1);
});

start();
