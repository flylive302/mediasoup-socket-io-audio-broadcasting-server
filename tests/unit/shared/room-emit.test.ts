/**
 * room-emit cascade-awareness — verifies the .local switch.
 *
 * The production bug fixed by this code path: with Cascade enabled and
 * multiple instances behind a Redis adapter, `socket.to(roomId).emit()`
 * delivered the raw `audio:newProducer` payload (origin's producerId) to
 * edge listeners ~ms before the cascade-relay HTTP path could rewrite to
 * the edge-local producerId. Edge listeners failed to consume.
 *
 * Fix: when cascade is configured, restrict the local emit to *this* node
 * via `.local` so cascade-relay HTTP becomes the single cross-instance
 * delivery path (it rewrites producerIds before broadcasting on each edge).
 */
import { describe, it, expect, vi } from "vitest";

// Mock config so the module graph (room-emit → logger → config) doesn't
// require real env vars (JWT_SECRET / LARAVEL_API_URL / LARAVEL_INTERNAL_KEY)
// to be present in the CI environment.
vi.mock("@src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
  isDev: false,
}));

vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { emitToRoom, broadcastToRoom } from "@src/shared/room-emit.js";
import type { Socket, Server } from "socket.io";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";

function makeSocket() {
  const emitTo = vi.fn();
  const localEmitTo = vi.fn();
  const to = vi.fn(() => ({ emit: emitTo }));
  const localTo = vi.fn(() => ({ emit: localEmitTo }));
  const socket = {
    to,
    local: { to: localTo },
  } as unknown as Socket;
  return { socket, to, emitTo, localTo, localEmitTo };
}

function makeNsp() {
  const emitTo = vi.fn();
  const localEmitTo = vi.fn();
  const to = vi.fn(() => ({ emit: emitTo }));
  const localTo = vi.fn(() => ({ emit: localEmitTo }));
  const nsp = {
    to,
    local: { to: localTo },
  } as unknown as Server;
  return { nsp, to, emitTo, localTo, localEmitTo };
}

function makeRelay(hasRemotes = false): CascadeRelay {
  return {
    hasRemotes: vi.fn(() => hasRemotes),
    relayToRemote: vi.fn(() => Promise.resolve()),
  } as unknown as CascadeRelay;
}

describe("emitToRoom", () => {
  it("uses adapter path (.to) when cascade is disabled", () => {
    const { socket, to, emitTo, localTo } = makeSocket();
    emitToRoom(socket, "room-1", "evt", { v: 1 }, null);

    expect(to).toHaveBeenCalledWith("room-1");
    expect(emitTo).toHaveBeenCalledWith("evt", { v: 1 });
    expect(localTo).not.toHaveBeenCalled();
  });

  it("uses node-local path (.local.to) when cascade is enabled", () => {
    const { socket, to, localTo, localEmitTo } = makeSocket();
    const relay = makeRelay(false);
    emitToRoom(socket, "room-2", "evt", { v: 2 }, relay);

    expect(localTo).toHaveBeenCalledWith("room-2");
    expect(localEmitTo).toHaveBeenCalledWith("evt", { v: 2 });
    expect(to).not.toHaveBeenCalled();
  });

  it("relays cross-region only when remotes exist", () => {
    const { socket } = makeSocket();
    const relay = makeRelay(true);
    emitToRoom(socket, "room-3", "evt", { v: 3 }, relay);
    expect(relay.relayToRemote).toHaveBeenCalledWith("room-3", "evt", { v: 3 });
  });

  it("does not relay when remotes are empty", () => {
    const { socket } = makeSocket();
    const relay = makeRelay(false);
    emitToRoom(socket, "room-4", "evt", { v: 4 }, relay);
    expect(relay.relayToRemote).not.toHaveBeenCalled();
  });
});

describe("broadcastToRoom", () => {
  it("uses adapter path (.to) when cascade is disabled", () => {
    const { nsp, to, emitTo, localTo } = makeNsp();
    broadcastToRoom(nsp, "room-1", "evt", { v: 1 }, null);

    expect(to).toHaveBeenCalledWith("room-1");
    expect(emitTo).toHaveBeenCalledWith("evt", { v: 1 });
    expect(localTo).not.toHaveBeenCalled();
  });

  it("uses node-local path (.local.to) when cascade is enabled", () => {
    const { nsp, to, localTo, localEmitTo } = makeNsp();
    const relay = makeRelay(false);
    broadcastToRoom(nsp, "room-2", "evt", { v: 2 }, relay);

    expect(localTo).toHaveBeenCalledWith("room-2");
    expect(localEmitTo).toHaveBeenCalledWith("evt", { v: 2 });
    expect(to).not.toHaveBeenCalled();
  });
});
