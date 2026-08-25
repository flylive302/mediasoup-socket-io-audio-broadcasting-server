import { describe, it, expect, vi } from "vitest";

vi.mock("@src/infrastructure/metrics.js", () => ({
  metrics: { redisDegradations: { inc: vi.fn() } },
}));

import { extractXp, persistUserXp, overlayUserXp, registerXpSourceClient } from "@src/shared/user-xp.js";
import { afterEach } from "vitest";

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

describe("overlayUserXp — cold key warms from Laravel", () => {
  afterEach(() => registerXpSourceClient(null));

  function coldRedis() {
    const exec = vi.fn().mockResolvedValue([]);
    const expire = vi.fn().mockReturnValue({ exec });
    const hset = vi.fn().mockReturnValue({ expire });
    return { hgetall: vi.fn().mockResolvedValue({}), multi: () => ({ hset }), _hset: hset } as any;
  }

  it("uses Laravel XP when redis is cold and persists it", async () => {
    registerXpSourceClient({
      getUserBalance: vi.fn().mockResolvedValue({ coins: "1", diamonds: "0", wealth_xp: "777", charm_xp: "88" }),
    } as any);
    const redis = coldRedis();
    const out = await overlayUserXp(redis, logger, user);
    expect(out.wealth_xp).toBe("777");
    expect(out.charm_xp).toBe("88");
    await new Promise((r) => setImmediate(r));
    expect(redis._hset).toHaveBeenCalledWith("user:7:xp", { wealth_xp: "777", charm_xp: "88" });
  });

  it("prefers redis over Laravel when key is warm", async () => {
    const getUserBalance = vi.fn();
    registerXpSourceClient({ getUserBalance } as any);
    const redis = { hgetall: vi.fn().mockResolvedValue({ wealth_xp: "1", charm_xp: "2" }) } as any;
    await overlayUserXp(redis, logger, user);
    expect(getUserBalance).not.toHaveBeenCalled();
  });

  it("fails open when Laravel errors or returns 404", async () => {
    registerXpSourceClient({ getUserBalance: vi.fn().mockRejectedValue(new Error("down")) } as any);
    expect(await overlayUserXp(coldRedis(), logger, user)).toBe(user);
    registerXpSourceClient({ getUserBalance: vi.fn().mockResolvedValue(null) } as any);
    expect(await overlayUserXp(coldRedis(), logger, user)).toBe(user);
  });
});
