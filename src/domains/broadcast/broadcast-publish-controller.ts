/**
 * BroadcastPublishController — wires the tested HLS pipeline into the live
 * system (realtime-09 EXECUTE/REACT orchestration).
 *
 * One broadcast session per Room: a `SpeakerMixer` (mediasoup RTP egress) + an
 * `HlsPublisher` (FFmpeg → R2). The controller is driven by two signals:
 *
 *  1. **Mode transition** (realtime-08): `promote` → start a session; `demote` →
 *     stop it. Hooked from `RoomModeService` after it persists+broadcasts the flip.
 *  2. **Speaker change**: a producer added / removed / paused (seat take/leave,
 *     moderator force-mute). Re-syncs the mix; FFmpeg restarts (debounced) only
 *     when the *resumed* producer set actually changed.
 *
 * ## Locked decisions baked in here
 *  - **Mix set = RESUMED audio producers**, not all non-closed. A paused producer
 *    (manager-mute) sends no RTP and would freeze the sample-synchronous `amix`
 *    (proven in the ffmpeg integration test), so it must be *excluded* and the
 *    publisher restarted — never left as a dead input.
 *  - **Self-mute stays resumed** (client disables the track; Opus DTX keeps the
 *    stream alive ⇒ no freeze, no restart). So self-mute is invisible here.
 *  - **start → resumeAll ordering**: consumers resume only after FFmpeg has had a
 *    moment to bind the SDP ports, so initial RTP isn't fired into closed ports.
 *
 * Entirely gated by `BROADCAST_HLS_ENABLED`: when off, every method is a no-op
 * and the mode flip remains realtime-08 telemetry only.
 *
 * The controller does **not** report a playback URL — it is deterministic
 * (`<base>/<roomId>/master.m3u8`) and gated by the Room's `mode`, so the Laravel
 * Room resource derives it from `mode` + config. This controller's sole job is to
 * make the segments actually land in R2 under that path while broadcasting.
 */
import type { Logger } from "pino";

/** The slice of RoomMediaCluster the controller needs (keeps it test-fakeable). */
export interface ClusterView {
  router: unknown | null;
  getSourceProducers(): Array<{ producerId: string; userId: number; kind: string }>;
  getProducer(id: string): { paused: boolean } | undefined;
}

/** Minimal mixer surface (satisfied by SpeakerMixer). */
export interface MixerLike {
  readonly size: number;
  sync(producerIds: string[]): Promise<boolean>;
  getSdp(): string;
  resumeAll(): Promise<void>;
  close(): void;
}

/** Minimal publisher surface (satisfied by HlsPublisher). */
export interface PublisherLike {
  start(sdp: string, inputCount: number): Promise<void>;
  restart(sdp: string, inputCount: number): void;
  stop(): Promise<void>;
}

export interface BroadcastControllerDeps {
  enabled: boolean;
  /** ms to wait after spawning FFmpeg before resuming consumers (port-bind grace). */
  startupGraceMs: number;
  getCluster(roomId: string): ClusterView | undefined;
  createMixer(router: unknown): MixerLike;
  createPublisher(roomId: string): PublisherLike;
  logger: Logger;
}

interface Session {
  mixer: MixerLike;
  publisher: PublisherLike;
  /** True once FFmpeg has been started (i.e. there is ≥1 speaker). */
  started: boolean;
}

export type ModeTransition = "promote" | "demote" | null;

export class BroadcastPublishController {
  private readonly sessions = new Map<string, Session>();
  /** Serialise per-Room operations so promote/change/stop never interleave. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BroadcastControllerDeps) {}

  /** True iff the Room is currently publishing HLS (used by self-mute to skip pause). */
  isBroadcasting(roomId: string): boolean {
    return this.sessions.get(roomId)?.started ?? false;
  }

  /** REACT hook from RoomModeService once a flip is persisted + broadcast. */
  onModeTransition(roomId: string, transition: ModeTransition): void {
    if (!this.deps.enabled || transition === null) return;
    if (transition === "promote") {
      this.enqueue(roomId, () => this.startBroadcast(roomId));
    } else {
      this.enqueue(roomId, () => this.stopRoom(roomId));
    }
  }

  /** A producer was added/removed/paused/resumed in the Room. */
  onSpeakerChange(roomId: string): void {
    if (!this.deps.enabled || !this.sessions.has(roomId)) return;
    this.enqueue(roomId, () => this.reconcile(roomId));
  }

  /** Room closed — tear down any session. */
  onRoomClosed(roomId: string): void {
    if (!this.deps.enabled || !this.sessions.has(roomId)) return;
    this.enqueue(roomId, () => this.stopRoom(roomId));
  }

  // ─────────────────────────────────────────────────────────────────
  // EXECUTE
  // ─────────────────────────────────────────────────────────────────

  private async startBroadcast(roomId: string): Promise<void> {
    if (this.sessions.has(roomId)) return;
    const cluster = this.deps.getCluster(roomId);
    if (!cluster?.router) {
      this.deps.logger.warn({ roomId }, "Broadcast promote: no cluster/router");
      return;
    }
    const mixer = this.deps.createMixer(cluster.router);
    const publisher = this.deps.createPublisher(roomId);
    const session: Session = { mixer, publisher, started: false };
    this.sessions.set(roomId, session);

    await mixer.sync(this.resumedAudioProducerIds(cluster));
    await this.ensurePublishing(session);
  }

  private async reconcile(roomId: string): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session) return;
    const cluster = this.deps.getCluster(roomId);
    if (!cluster?.router) return;

    const changed = await session.mixer.sync(this.resumedAudioProducerIds(cluster));
    if (!changed) return;

    if (session.mixer.size === 0) {
      // Every speaker muted/left — stop encoding (nothing to mix) but keep the
      // session so a returning speaker re-starts it.
      if (session.started) {
        await session.publisher.stop();
        session.started = false;
      }
      return;
    }

    if (!session.started) {
      await this.ensurePublishing(session);
      return;
    }

    // Already publishing: resume any newly-added consumers (idempotent for the
    // rest) and restart FFmpeg (debounced) onto the new topology.
    await session.mixer.resumeAll();
    session.publisher.restart(session.mixer.getSdp(), session.mixer.size);
  }

  /** Start FFmpeg for the current mix (≥1 speaker), then resume consumers. */
  private async ensurePublishing(session: Session): Promise<void> {
    if (session.started || session.mixer.size === 0) return;
    await session.publisher.start(session.mixer.getSdp(), session.mixer.size);
    // #3: give FFmpeg a moment to bind the SDP ports before RTP starts flowing.
    if (this.deps.startupGraceMs > 0) {
      await new Promise((r) => setTimeout(r, this.deps.startupGraceMs));
    }
    await session.mixer.resumeAll();
    session.started = true;
  }

  private async stopRoom(roomId: string): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session) return;
    this.sessions.delete(roomId);
    session.mixer.close();
    await session.publisher.stop();
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  /** Resumed audio producers only — paused producers send no RTP (would freeze amix). */
  private resumedAudioProducerIds(cluster: ClusterView): string[] {
    return cluster
      .getSourceProducers()
      .filter((p) => p.kind === "audio")
      .map((p) => p.producerId)
      .filter((id) => {
        const producer = cluster.getProducer(id);
        return producer !== undefined && !producer.paused;
      });
  }

  /** Run `op` after any in-flight op for this Room; swallow+log errors (REACT). */
  private enqueue(roomId: string, op: () => Promise<void>): void {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(op)
      .catch((err) =>
        this.deps.logger.error({ err, roomId }, "Broadcast op failed"),
      );
    this.chains.set(roomId, next);
    void next.finally(() => {
      if (this.chains.get(roomId) === next) this.chains.delete(roomId);
    });
  }
}
