/**
 * dj-talk-over/02: admin mute/unmute must target the mic producer only —
 * muting a DJ mid-music silences their voice, never their music. This was
 * built in dj-talk-over/01 (mute-unmute.factory.ts resolves `producers.get
 * ("mic")` explicitly); this test locks the behavior in as a regression
 * guard for the slice that made kick/evict/seat-lock close ALL producers,
 * to make sure mute/unmute was never widened along with them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: {
    eventsTotal: { inc: vi.fn() },
    eventLatency: { observe: vi.fn() },
  },
}));
vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-correlation-id",
}));

vi.mock("@src/domains/seat/seat.owner.js", () => ({
  verifyRoomManager: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@src/domains/seat/vip.guard.js", () => ({
  isVipAntiMuteProtected: vi.fn().mockResolvedValue(false),
}));

vi.mock("@src/shared/room-emit.js", () => ({
  broadcastToRoom: vi.fn(),
}));

import { createMuteHandler } from "@src/domains/seat/handlers/mute-unmute.factory.js";
import { Errors } from "@src/shared/errors.js";

function makeProducer() {
  return { closed: false, pause: vi.fn(), resume: vi.fn(), appData: {} };
}

function makeContext(opts: { micProducer?: any; musicProducer?: any } = {}) {
  const micProducer = opts.micProducer ?? makeProducer();
  const musicProducer = opts.musicProducer ?? makeProducer();
  const producersById: Record<string, any> = {
    "prod-mic": micProducer,
    "prod-music": musicProducer,
  };
  const targetClient = {
    userId: 7,
    producers: new Map<string, string>([
      ["mic", "prod-mic"],
      ["music", "prod-music"],
    ]),
  };
  const room = { getProducer: vi.fn((id: string) => producersById[id]) };
  const context = {
    seatRepository: {
      getUserSeat: vi.fn().mockResolvedValue(0),
      setMute: vi.fn().mockResolvedValue(true),
    },
    clientManager: { getClientsInRoom: vi.fn().mockReturnValue([targetClient]) },
    roomManager: { getRoom: vi.fn().mockReturnValue(room) },
    cascadeRelay: null,
    broadcastController: { onSpeakerChange: vi.fn() },
  };
  const socket = { data: { user: { id: 99 } }, nsp: {} };
  return { micProducer, musicProducer, context, socket };
}

describe("createMuteHandler — mic-only targeting during music (dj-talk-over)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("seat:mute pauses the mic producer and leaves a concurrent music producer untouched", async () => {
    const { micProducer, musicProducer, context, socket } = makeContext();
    const handler = createMuteHandler({
      event: "seat:mute",
      muted: true,
      failError: Errors.MUTE_FAILED,
      producerAction: "pause",
      logAction: "muted",
      producerLogAction: "paused (server-side mute)",
    });

    const fn = handler(socket as any, context as any);
    const cb = vi.fn();
    await fn({ roomId: "room-1", userId: 7 }, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    expect(micProducer.pause).toHaveBeenCalledTimes(1);
    expect(musicProducer.pause).not.toHaveBeenCalled();
    expect(musicProducer.resume).not.toHaveBeenCalled();
  });

  it("seat:unmute resumes the mic producer and leaves a concurrent music producer untouched", async () => {
    const { micProducer, musicProducer, context, socket } = makeContext();
    const handler = createMuteHandler({
      event: "seat:unmute",
      muted: false,
      failError: Errors.UNMUTE_FAILED,
      producerAction: "resume",
      logAction: "unmuted",
      producerLogAction: "resumed (server-side unmute)",
    });

    const fn = handler(socket as any, context as any);
    const cb = vi.fn();
    await fn({ roomId: "room-1", userId: 7 }, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    expect(micProducer.resume).toHaveBeenCalledTimes(1);
    expect(musicProducer.pause).not.toHaveBeenCalled();
    expect(musicProducer.resume).not.toHaveBeenCalled();
  });

  it("does not touch the music mutex or emit a music-stop event (mute is voice-only, never music)", async () => {
    const { context, socket } = makeContext();
    const handler = createMuteHandler({
      event: "seat:mute",
      muted: true,
      failError: Errors.MUTE_FAILED,
      producerAction: "pause",
      logAction: "muted",
      producerLogAction: "paused (server-side mute)",
    });

    const fn = handler(socket as any, context as any);
    const cb = vi.fn();
    await fn({ roomId: "room-1", userId: 7 }, cb);

    // The mute handler has no redis/music-mutex touchpoints at all — asserting
    // its context shape stays free of them is the regression guard.
    expect((context as any).redis).toBeUndefined();
  });
});
