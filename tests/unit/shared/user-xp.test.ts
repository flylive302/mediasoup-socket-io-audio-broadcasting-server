import { describe, it, expect, vi } from "vitest";

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { redisDegradations: { inc: vi.fn() } },
}));

import { extractXp, persistUserXp, overlayUserXp } from "@src/shared/user-xp.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const user = { id: 7, name: "u", wealth_xp: "10", charm_xp: "5" } as any;

describe("extractXp", () => {
  it("returns numeric-string xp fields", () => {
    expect(extractXp({ wealth_xp: "120", charm_xp: "3", coins: "1" })).toEqual({
      wealth_xp: "120",
      charm_xp: "3",
    });
  });
  it("rejects missing or non-numeric fields", () => {
    expect(extractXp({ wealth_xp: "1" })).toBeNull();
    expect(extractXp({ wealth_xp: 1, charm_xp: "2" })).toBeNull();
    expect(extractXp({ wealth_xp: "abc", charm_xp: "2" })).toBeNull();
  });
});

describe("persistUserXp", () => {
  it("writes hash + ttl in one multi", async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const expire = vi.fn().mockReturnValue({ exec });
    const hset = vi.fn().mockReturnValue({ expire });
    const redis = { multi: () => ({ hset }) } as any;
    await persistUserXp(redis, logger, 7, { wealth_xp: "99", charm_xp: "1" });
    expect(hset).toHaveBeenCalledWith("user:7:xp", { wealth_xp: "99", charm_xp: "1" });
    expect(expire).toHaveBeenCalledWith("user:7:xp", 72 * 3600);
  });
  it("swallows redis errors", async () => {
    const redis = { multi: () => { throw new Error("down"); } } as any;
    await expect(persistUserXp(redis, logger, 7, { wealth_xp: "1", charm_xp: "1" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("overlayUserXp", () => {
  it("prefers persisted xp over jwt snapshot", async () => {
    const redis = { hgetall: vi.fn().mockResolvedValue({ wealth_xp: "5000", charm_xp: "800" }) } as any;
    const out = await overlayUserXp(redis, logger, user);
    expect(out.wealth_xp).toBe("5000");
    expect(out.charm_xp).toBe("800");
    expect(out.name).toBe("u");
  });
  it("keeps jwt values when nothing persisted", async () => {
    const redis = { hgetall: vi.fn().mockResolvedValue({}) } as any;
    expect(await overlayUserXp(redis, logger, user)).toBe(user);
  });
  it("fails open on redis error", async () => {
    const redis = { hgetall: vi.fn().mockRejectedValue(new Error("down")) } as any;
    expect(await overlayUserXp(redis, logger, user)).toBe(user);
  });
});
