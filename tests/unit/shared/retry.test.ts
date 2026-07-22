import { describe, it, expect, vi } from "vitest";
import { retryAsync } from "@src/shared/retry.js";

describe("retryAsync", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryAsync(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after a rejection and returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");
    await expect(retryAsync(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent"));
    await expect(
      retryAsync(fn, { attempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries falsy results when accept rejects them, returning the last", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("value");
    await expect(
      retryAsync(fn, { baseDelayMs: 1, accept: (r) => Boolean(r) }),
    ).resolves.toBe("value");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns the last rejected-by-accept result when attempts run out", async () => {
    const fn = vi.fn().mockResolvedValue(null);
    await expect(
      retryAsync(fn, { attempts: 2, baseDelayMs: 1, accept: (r) => Boolean(r) }),
    ).resolves.toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // prod-bugs 09: futile-by-construction errors must abort instead of retrying.
  it("shouldRetry:false aborts immediately and rethrows the original error", async () => {
    const fn = vi.fn().mockRejectedValue(
      new Error("Channel request handler with ID x already exists"),
    );
    await expect(
      retryAsync(fn, {
        attempts: 3,
        baseDelayMs: 1,
        shouldRetry: (err) =>
          !(err instanceof Error && err.message.includes("already exists")),
      }),
    ).rejects.toThrow("already exists");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the attempt number to the callback", async () => {
    const attempts: number[] = [];
    await retryAsync(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error("again");
        return "done";
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(attempts).toEqual([1, 2, 3]);
  });
});
