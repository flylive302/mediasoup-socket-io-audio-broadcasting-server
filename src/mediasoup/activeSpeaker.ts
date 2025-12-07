import type * as mediasoup from 'mediasoup';
import type { Server as SocketServer } from 'socket.io';
import type { Logger } from '../core/logger.js';

export class ActiveSpeakerDetector {
  constructor(
    private readonly observer: mediasoup.types.ActiveSpeakerObserver,
    private readonly roomId: string,
    private readonly io: SocketServer,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.observer.on('dominantspeaker', ({ producer }: { producer: mediasoup.types.Producer }) => {
      const userId = producer.appData.userId as string;
      
      this.logger.debug({ roomId: this.roomId, userId }, 'New dominant speaker');
      
      this.io.to(this.roomId).emit('speaker:active', {
        userId,
        volume: 0, // Mediasoup doesn't give volume in this event, use audioLevelObserver for that if needed
        timestamp: Date.now(),
      });
    });
  }

  stop(): void {
    this.observer.removeAllListeners();
  }
}
