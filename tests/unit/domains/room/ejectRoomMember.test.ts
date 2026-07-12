/**
 * dj-talk-over/02: kick (ADR 0017's ejectRoomMember, driven by the
 * room.member_removed fanout) must close EVERY producer the ejected user
 * holds (mic + music) and release the room's music mutex + broadcast stop
 * if they held it — a kicked DJ's music must die with them. Kicking a
 * non-DJ must never touch the room's music.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    AWS_REGION: "test-region",
    PUBLIC_IP: null,
    MEDIASOUP_ANNOUNCED_IP: null,
    PORT: 3030,
  },
}));
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ejectRoomMember } from "@src/domains/room/ejectRoomMember.js";

function makeProducer(userId: number) {
  return { closed: false, appData: { userId }, close: vi.fn() };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeIo(targetSocket: any) {
  const roomEmit = vi.fn();
  return {
    to: vi.fn(() => ({ emit: roomEmit })),
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([targetSocket]) })),
    roomEmit,
  } as any;
}

function makeTargetSocket(userId: number) {
  return {
    id: "sock-target",
    data: { user: { id: userId } },
    leave: vi.fn(),
  };
}

describe("ejectRoomMember — producer + music cleanup (dj-talk-over/02)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes ALL the ejected user's producers (mic + music)", async () => {
    const userId = 42;
    const micProducer = makeProducer(userId);
    const musicProducer = makeProducer(userId);
    const localClient = {
      userId,
      producers: new Map([
        ["mic", "prod-mic"],
        ["music", "prod-music"],
      ]),
      isSpeaker: true,
    };
    const targetSocket = makeTargetSocket(userId);
    const io = makeIo(targetSocket);
    const room = {
      getProducer: vi.fn((id: string) => (id === "prod-mic" ? micProducer : musicProducer)),
    };

    const deps = {
      io,
      seatRepository: { leaveSeat: vi.fn().mockResolvedValue({ success: false }) },
      clientManager: {
        getClient: vi.fn().mockReturnValue(localClient),
        clearClientRoom: vi.fn(),
      },
      roomStateRepo: { adjustParticipantCount: vi.fn().mockResolvedValue(0) },
      statusCoalescer: { submit: vi.fn() },
      userRoomRepository: { clearUserRoom: vi.fn().mockResolvedValue(undefined) },
      logger: makeLogger(),
      redis: { get: vi.fn().mockResolvedValue(null), del: vi.fn() },
      cascadeRelay: null,
      getRoom: vi.fn().mockReturnValue(room),
    };

    await ejectRoomMember(deps as any, "room-1", userId);

    expect(micProducer.close).toHaveBeenCalledTimes(1);
    expect(musicProducer.close).toHaveBeenCalledTimes(1);
    expect(localClient.producers.size).toBe(0);
  });

  it("releases the music mutex + broadcasts stop when the ejected user held it", async () => {
    const userId = 42;
    const targetSocket = makeTargetSocket(userId);
    const io = makeIo(targetSocket);
    const redis = { get: vi.fn().mockResolvedValue(String(userId)), del: vi.fn() };

    const deps = {
      io,
      seatRepository: { leaveSeat: vi.fn().mockResolvedValue({ success: false }) },
      clientManager: { getClient: vi.fn().mockReturnValue(undefined), clearClientRoom: vi.fn() },
      roomStateRepo: { adjustParticipantCount: vi.fn().mockResolvedValue(0) },
      statusCoalescer: { submit: vi.fn() },
      userRoomRepository: { clearUserRoom: vi.fn().mockResolvedValue(undefined) },
      logger: makeLogger(),
      redis,
      cascadeRelay: null,
      getRoom: vi.fn(),
    };

    await ejectRoomMember(deps as any, "room-1", userId);

    expect(redis.del).toHaveBeenCalledWith("room:room-1:musicPlayer");
    expect(redis.del).toHaveBeenCalledWith("room:room-1:musicState");
    expect(io.roomEmit).toHaveBeenCalledWith(
      "audioPlayer:stateChanged",
      expect.objectContaining({ state: "stopped", userId }),
    );
  });

  it("does NOT touch the music mutex when the ejected user was not the current DJ", async () => {
    const userId = 42;
    const targetSocket = makeTargetSocket(userId);
    const io = makeIo(targetSocket);
    const redis = { get: vi.fn().mockResolvedValue("999"), del: vi.fn() };

    const deps = {
      io,
      seatRepository: { leaveSeat: vi.fn().mockResolvedValue({ success: false }) },
      clientManager: { getClient: vi.fn().mockReturnValue(undefined), clearClientRoom: vi.fn() },
      roomStateRepo: { adjustParticipantCount: vi.fn().mockResolvedValue(0) },
      statusCoalescer: { submit: vi.fn() },
      userRoomRepository: { clearUserRoom: vi.fn().mockResolvedValue(undefined) },
      logger: makeLogger(),
      redis,
      cascadeRelay: null,
      getRoom: vi.fn(),
    };

    await ejectRoomMember(deps as any, "room-1", userId);

    expect(redis.del).not.toHaveBeenCalled();
    expect(io.roomEmit).not.toHaveBeenCalledWith(
      "audioPlayer:stateChanged",
      expect.anything(),
    );
  });

  it("no-ops the producer/music cleanup when media deps are unset (back-compat)", async () => {
    const userId = 42;
    const targetSocket = makeTargetSocket(userId);
    const io = makeIo(targetSocket);

    const deps = {
      io,
      seatRepository: { leaveSeat: vi.fn().mockResolvedValue({ success: false }) },
      clientManager: { getClient: vi.fn().mockReturnValue(undefined), clearClientRoom: vi.fn() },
      roomStateRepo: { adjustParticipantCount: vi.fn().mockResolvedValue(0) },
      statusCoalescer: { submit: vi.fn() },
      userRoomRepository: { clearUserRoom: vi.fn().mockResolvedValue(undefined) },
      logger: makeLogger(),
      // redis/cascadeRelay/getRoom all omitted
    };

    await expect(ejectRoomMember(deps as any, "room-1", userId)).resolves.not.toThrow();
  });
});
