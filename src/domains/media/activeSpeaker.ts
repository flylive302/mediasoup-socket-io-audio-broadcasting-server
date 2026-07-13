/**
 * ActiveSpeakerDetector — concurrent speaking-user tracking
 *
 * Uses mediasoup's AudioLevelObserver, which reports ALL producers above the
 * volume threshold every interval (`volumes`) and fires `silence` when the
 * room goes quiet. Unlike ActiveSpeakerObserver there is no single dominant
 * speaker — everyone currently talking is reported, so multiple mice-wave
 * indicators can be visible at once.
 *
 * Emits `speaker:active` on every `volumes` tick (even if the set is
 * unchanged) so the frontend's decay timer keeps being refreshed during
 * continuous speech, and an empty set on `silence` for an immediate clear.
 */
import type * as mediasoup from "mediasoup";
import type { Server as SocketServer } from "socket.io";

export class ActiveSpeakerDetector {
  constructor(
    private readonly observer: mediasoup.types.AudioLevelObserver,
    private readonly roomId: string,
    private readonly io: SocketServer,
  ) {}

  start(): void {
    this.observer.on(
      "volumes",
      (volumes: mediasoup.types.AudioLevelObserverVolume[]) => {
        // Dedupe: a user can in principle have several audio producers.
        const speakingUserIds = [
          ...new Set(
            volumes.map((v) => v.producer.appData.userId as string),
          ),
        ];
        this.emitActive(speakingUserIds);
      },
    );

    this.observer.on("silence", () => {
      this.emitActive([]);
    });
  }

  stop(): void {
    this.observer.removeAllListeners();
  }

  private emitActive(userIds: string[]): void {
    this.io.to(this.roomId).emit("speaker:active", {
      userId: userIds[0] ?? "",
      activeSpeakers: userIds,
      timestamp: Date.now(),
    });
  }
}
