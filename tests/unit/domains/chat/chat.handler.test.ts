import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * We test the chat handler's core logic by importing it and invoking
 * the returned event handler directly with mocked Socket + AppContext.
 */

// We need to import the handler — it's a named export wrapping createHandler
// Since createHandler returns (socket, context) => (payload, cb) => ...,
// we import the module and call the inner function.

// Mock logger to avoid noise
vi.mock("@src/infrastructure/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock("@src/config/index.js", () => ({
  config: {
    RATE_LIMIT_MESSAGES_PER_MINUTE: 60,
  },
}));

// Mock crypto (createHandler uses generateCorrelationId)
vi.mock("@src/shared/crypto.js", () => ({
  generateCorrelationId: () => "test-correlation-id",
}));

// Import the handler after mocks
import { chatHandler } from "@src/domains/chat/chat.handler.js";
import type { AppContext } from "@src/context.js";

// Helper: create a mock socket
function createMockSocket(opts: { userId?: number; roomId?: string; inRoom?: boolean } = {}) {
  const { userId = 1, roomId = "room-1", inRoom = true } = opts;
  const rooms = new Set<string>();
  if (inRoom && roomId) rooms.add(roomId);

  return {
    data: {
      user: {
        id: userId,
        name: "TestUser",
        avatar: "https://example.com/avatar.png",
      },
    },
    rooms,
    nsp: {
      in: vi.fn().mockReturnValue({ emit: vi.fn() }),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    },
    on: vi.fn(),
  } as any;
}

// Helper: create a mock context
function createMockContext(): AppContext {
  return {
    rateLimiter: {
      isAllowed: vi.fn().mockResolvedValue(true),
    },
    autoCloseService: {
      recordActivity: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

describe("chatHandler registration", () => {
  it("registers chat:message event on socket", () => {
    const socket = createMockSocket();
    const context = createMockContext();

    chatHandler(socket, context);

    expect(socket.on).toHaveBeenCalledWith("chat:message", expect.any(Function));
  });
});

describe("chat:message handler", () => {
  let socket: any;
  let context: any;
  let handler: (payload: unknown, callback?: (result: any) => void) => Promise<void>;

  beforeEach(() => {
    socket = createMockSocket({ userId: 42, roomId: "room-7", inRoom: true });
    context = createMockContext();

    // Register and capture the inner handler
    chatHandler(socket, context);
    handler = socket.on.mock.calls[0][1];
  });

  it("broadcasts message to room on valid payload", async () => {
    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "Hello!" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    expect(socket.nsp.in).toHaveBeenCalledWith("room-7");
  });

  it("rejects when socket is NOT in the room", async () => {
    // Remove room membership
    socket.rooms.delete("room-7");

    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "Hello!" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: "Not in room" });
    // Should NOT broadcast
    expect(socket.nsp.in).not.toHaveBeenCalled();
  });

  it("rejects when rate limit is exceeded", async () => {
    context.rateLimiter.isAllowed.mockResolvedValue(false);

    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "spam" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: "Too many messages" });
    expect(socket.nsp.in).not.toHaveBeenCalled();
  });

  it("uses per-user-per-room rate-limit key", async () => {
    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "hi" }, cb);

    expect(context.rateLimiter.isAllowed).toHaveBeenCalledWith(
      "chat:42:room-7",
      60,
      60,
    );
  });

  it("records auto-close activity on successful message", async () => {
    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "hi" }, cb);

    expect(context.autoCloseService.recordActivity).toHaveBeenCalledWith("room-7");
  });

  it("rejects invalid payload (empty content)", async () => {
    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: "Invalid payload" });
  });

  it("rejects invalid payload (missing roomId)", async () => {
    const cb = vi.fn();
    await handler({ content: "hello" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: false, error: "Invalid payload" });
  });

  it("defaults message type to 'text' when omitted", async () => {
    const cb = vi.fn();
    await handler({ roomId: "room-7", content: "hi" }, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    // Verify the emitted message has type "text"
    // The handler called socket.nsp.in("room-7") → check results[0] (first call from handler)
    const inReturnValue = socket.nsp.in.mock.results[0].value;
    expect(inReturnValue.emit).toHaveBeenCalledWith(
      "chat:message",
      expect.objectContaining({ type: "text" }),
    );
  });
});
