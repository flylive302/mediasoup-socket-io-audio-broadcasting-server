import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    PRESENCE_SUBSCRIBE_MAX: 50,
  },
}));
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

import { presenceHandler } from "@src/domains/presence/index.js";
import { presenceUserRoom } from "@src/domains/presence/presence.service.js";
import { Errors } from "@src/shared/errors.js";

function createMockSocket(userId: number) {
  return {
    id: `socket-${userId}`,
    data: { user: { id: userId } },
    on: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockContext(snapshot: Record<number, boolean> = {}) {
  return {
    presenceService: {
      snapshot: vi.fn().mockResolvedValue(snapshot),
    },
  } as any;
}

function getEventHandler(socket: any, context: any, event: string) {
  presenceHandler(socket, context);
  const call = socket.on.mock.calls.find(([e]: [string]) => e === event);
  return call[1];
}

describe("presence:subscribe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("joins presence:user:{id} rooms and returns the EXISTS snapshot", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext({ 2: true, 3: false });
    const handler = getEventHandler(socket, context, "presence:subscribe");

    const cb = vi.fn();
    await handler({ userIds: [2, 3] }, cb);

    expect(socket.join).toHaveBeenCalledWith(presenceUserRoom(2));
    expect(socket.join).toHaveBeenCalledWith(presenceUserRoom(3));
    expect(context.presenceService.snapshot).toHaveBeenCalledWith([2, 3]);
    expect(cb).toHaveBeenCalledWith({ success: true, data: { 2: true, 3: false } });
  });

  it("rejects malformed payloads at GATE with no join / no snapshot call", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "presence:subscribe");

    const cb = vi.fn();
    await handler({}, cb);

    expect(socket.join).not.toHaveBeenCalled();
    expect(context.presenceService.snapshot).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });
  });

  it("caps at PRESENCE_SUBSCRIBE_MAX ids per socket", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "presence:subscribe");

    const cb = vi.fn();
    const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
    await handler({ userIds: tooMany }, cb);

    // Rejected before the handler's own cap check because the Zod schema
    // itself bounds the array to max(50) — either gate produces the same
    // INVALID_PAYLOAD outcome with zero side effects.
    expect(socket.join).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });
  });
});

describe("presence:unsubscribe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leaves presence:user:{id} rooms", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "presence:unsubscribe");

    const cb = vi.fn();
    await handler({ userIds: [2, 3] }, cb);

    expect(socket.leave).toHaveBeenCalledWith(presenceUserRoom(2));
    expect(socket.leave).toHaveBeenCalledWith(presenceUserRoom(3));
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("rejects malformed payloads at GATE with no leave", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "presence:unsubscribe");

    const cb = vi.fn();
    await handler({ userIds: [] }, cb);

    expect(socket.leave).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });
  });
});
