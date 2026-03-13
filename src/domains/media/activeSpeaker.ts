/**
 * ActiveSpeakerDetector — Sliding window top-N active speaker tracking
 *
 * Uses mediasoup's ActiveSpeakerObserver to detect dominant speakers,
 * maintains a sliding window of the top N most recent speakers,
 * and emits speaker:active events for the frontend UI.
 */
import type * as mediasoup from "mediasoup";
import type { Server as SocketServer } from "socket.io";
import { config } from "@src/config/index.js";

interface SpeakerEntry {
  producerId: string;
  userId: string;
  lastActiveAt: number;
}

export class ActiveSpeakerDetector {
  /** Sliding window of recent speakers, ordered by lastActiveAt (newest first) */
  private readonly recentSpeakers = new Map<string, SpeakerEntry>();

  /** Current top-N active speaker producer IDs */
  private currentActiveSpeakers: string[] = [];



  constructor(
    private readonly observer: mediasoup.types.ActiveSpeakerObserver,
    private readonly roomId: string,
    private readonly io: SocketServer,
  ) {}



  start(): void {
    this.observer.on(
      "dominantspeaker",
      ({ producer }: { producer: mediasoup.types.Producer }) => {
        const userId = producer.appData.userId as string;

        // Update the sliding window
        this.recentSpeakers.set(producer.id, {
          producerId: producer.id,
          userId,
          lastActiveAt: Date.now(),
        });

        // Compute top N most recent speakers
        const topN = this.computeTopN();
        const topNIds = topN.map((s) => s.producerId);

        // Check if the active set actually changed
        const changed = this.hasActiveSetChanged(topNIds);

        // PERF-003 FIX: Only emit when the active speaker set actually changed
        if (changed) {
          this.currentActiveSpeakers = topNIds;



          // Emit to frontend only when set changed
          this.io.to(this.roomId).emit("speaker:active", {
            userId,
            activeSpeakers: topN.map((s) => s.userId),
            timestamp: Date.now(),
          });
        }
      },
    );
  }

  stop(): void {
    this.observer.removeAllListeners();
    this.recentSpeakers.clear();
    this.currentActiveSpeakers = [];
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Compute the top N most recently active speakers.
   * PERF-002 FIX: Single-pass top-N selection O(k*N) instead of full sort O(N*logN)
   * Evicts stale entries older than 10 seconds.
   */
  private computeTopN(): SpeakerEntry[] {
    const maxN = config.MAX_ACTIVE_SPEAKERS_FORWARDED;
    const staleCutoff = Date.now() - 10_000; // 10s window

    // Remove stale speakers
    for (const [id, entry] of this.recentSpeakers) {
      if (entry.lastActiveAt < staleCutoff) {
        this.recentSpeakers.delete(id);
      }
    }

    // Single-pass top-N selection — O(k*N) is faster than sort O(N*logN) for small k
    const topN: SpeakerEntry[] = [];
    for (const entry of this.recentSpeakers.values()) {
      if (topN.length < maxN) {
        topN.push(entry);
      } else {
        // Find the oldest in topN and replace if this entry is newer
        let minIdx = 0;
        for (let i = 1; i < topN.length; i++) {
          if (topN[i]!.lastActiveAt < topN[minIdx]!.lastActiveAt) minIdx = i;
        }
        if (entry.lastActiveAt > topN[minIdx]!.lastActiveAt) {
          topN[minIdx] = entry;
        }
      }
    }

    return topN;
  }

  /** Check if the active speaker set has changed */
  private hasActiveSetChanged(newIds: string[]): boolean {
    if (newIds.length !== this.currentActiveSpeakers.length) return true;

    const currentSet = new Set(this.currentActiveSpeakers);
    return newIds.some((id) => !currentSet.has(id));
  }
}
