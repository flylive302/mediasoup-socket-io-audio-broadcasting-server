import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock config + logger BEFORE importing the handler — `src/config` validates
// env via Zod at module load and `process.env` is empty in CI.
vi.mock("@src/config/index.js", () => ({
  config: {
    RATE_LIMIT_TYPING_PER_WINDOW: 1,
    RATE_LIMIT_TYPING_WINDOW_SECONDS: 2,
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

import { inboxTypingHandler, dmThreadUserRoom } from "@src/domains/inbox-typing/index.js";
import { Errors } from "@src/shared/errors.js";

function createMockSocket(userId: number) {
  return {
    id: `socket-${userId}`,
    data: { user: { id: userId } },
    on: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
  } as any;
}

function createMockContext(rateLimitAllowed = true) {
  return {
    rateLimiter: {
      isAllowed: vi.fn().mockResolvedValue(rateLimitAllowed),
    },
  } as any;
}

function getEventHandler(socket: any, context: any, event: string) {
  inboxTypingHandler(socket, context);
  const call = socket.on.mock.calls.find(([e]: [string]) => e === event);
  return call[1];
}

describe("dm:thread.opened / dm:thread.closed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("joins the per-(thread, self) room on open", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "dm:thread.opened");

    const cb = vi.fn();
    await handler({ threadId: "thread-1" }, cb);

    expect(socket.join).toHaveBeenCalledWith(dmThreadUserRoom("thread-1", 1));
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("leaves the per-(thread, self) room on close", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "dm:thread.closed");

    const cb = vi.fn();
    await handler({ threadId: "thread-1" }, cb);

    expect(socket.leave).toHaveBeenCalledWith(dmThreadUserRoom("thread-1", 1));
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("rejects malformed open/close payloads at GATE with no join/leave", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const openHandler = getEventHandler(socket, context, "dm:thread.opened");
    const closeHandler = getEventHandler(socket, context, "dm:thread.closed");

    const cb1 = vi.fn();
    await openHandler({}, cb1);
    expect(socket.join).not.toHaveBeenCalled();
    expect(cb1).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });

    const cb2 = vi.fn();
    await closeHandler({ threadId: "" }, cb2);
    expect(socket.leave).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });
  });
});

describe("dm:typing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects malformed payloads at GATE with no relay", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "dm:typing");

    const cb = vi.fn();
    await handler({ threadId: "thread-1" }, cb); // missing peerUserId

    expect(socket.to).not.toHaveBeenCalled();
    expect(context.rateLimiter.isAllowed).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });
  });

  it("rejects typing at yourself", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext();
    const handler = getEventHandler(socket, context, "dm:typing");

    const cb = vi.fn();
    await handler({ threadId: "thread-1", peerUserId: 1 }, cb);

    expect(socket.to).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.INVALID_PAYLOAD });
  });

  it("relays only into the peer's (threadId, peerUserId) room, scoped by thread-open state", async () => {
    const socket = createMockSocket(1);
    const emitMock = vi.fn();
    socket.to.mockReturnValue({ emit: emitMock });
    const context = createMockContext(true);
    const handler = getEventHandler(socket, context, "dm:typing");

    const cb = vi.fn();
    await handler({ threadId: "thread-1", peerUserId: 2 }, cb);

    expect(context.rateLimiter.isAllowed).toHaveBeenCalledWith(
      "dm:typing:1:thread-1",
      1,
      2,
    );
    expect(socket.to).toHaveBeenCalledWith(dmThreadUserRoom("thread-1", 2));
    expect(emitMock).toHaveBeenCalledWith("dm:typing", { threadId: "thread-1", userId: 1 });
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it("rate limit engages under a burst — denies and does not relay", async () => {
    const socket = createMockSocket(1);
    const context = createMockContext(false); // rate limiter denies
    const handler = getEventHandler(socket, context, "dm:typing");

    const cb = vi.fn();
    await handler({ threadId: "thread-1", peerUserId: 2 }, cb);

    expect(socket.to).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: false, error: Errors.RATE_LIMITED });
  });
});
