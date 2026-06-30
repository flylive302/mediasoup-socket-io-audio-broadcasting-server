import { describe, expect, it, vi } from "vitest";
import { fetchSocketsSafe } from "@src/shared/fetch-sockets-safe.js";

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as import("@src/infrastructure/logger.js").Logger;

function makeIo(operator: Record<string, unknown>) {
  return { in: vi.fn().mockReturnValue(operator) } as never;
}

describe("fetchSocketsSafe", () => {
  it("returns the cross-node sockets on success", async () => {
    const sockets = [{ id: "a" }];
    const io = makeIo({ fetchSockets: vi.fn().mockResolvedValue(sockets) });

    await expect(fetchSocketsSafe(io, "r", logger)).resolves.toBe(sockets);
  });

  it("falls back to LOCAL sockets when the cross-node fetch rejects (ghost subscriber)", async () => {
    const local = [{ id: "local" }];
    const io = makeIo({
      fetchSockets: vi
        .fn()
        .mockRejectedValue(
          new Error("timeout reached while waiting for fetchSockets response"),
        ),
      local: { fetchSockets: vi.fn().mockResolvedValue(local) },
    });

    await expect(fetchSocketsSafe(io, "r", logger)).resolves.toBe(local);
  });

  it("falls back to LOCAL sockets when the cross-node fetch exceeds the timeout", async () => {
    const local = [{ id: "local" }];
    const io = makeIo({
      // Never resolves — only the race timeout can settle this.
      fetchSockets: vi.fn().mockReturnValue(new Promise(() => {})),
      local: { fetchSockets: vi.fn().mockResolvedValue(local) },
    });

    await expect(fetchSocketsSafe(io, "r", logger, 20)).resolves.toBe(local);
  });

  it("returns an empty list when both cross-node and local fetch fail", async () => {
    const io = makeIo({
      fetchSockets: vi.fn().mockRejectedValue(new Error("cross fail")),
      local: { fetchSockets: vi.fn().mockRejectedValue(new Error("local fail")) },
    });

    await expect(fetchSocketsSafe(io, "r", logger)).resolves.toEqual([]);
  });
});
