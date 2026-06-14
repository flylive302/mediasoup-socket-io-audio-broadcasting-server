import { describe, it, expect, beforeEach } from "vitest";
import { ActiveAppSlidesRepository } from "@src/domains/slide/active-app-slides.repository.js";

/**
 * Minimal in-memory fake of the ZSET ops the repository uses. Avoids a Redis
 * dependency while exercising the real prune/cap/order logic.
 */
class FakeRedis {
  private store = new Map<string, Array<{ score: number; member: string }>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const arr = this.store.get(key) ?? [];
    const existing = arr.find((e) => e.member === member);
    if (existing) existing.score = score;
    else arr.push({ score, member });
    this.store.set(key, arr);
    return 1;
  }

  async zremrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
  ): Promise<number> {
    const arr = this.store.get(key);
    if (!arr) return 0;
    const lo = min === "-inf" ? -Infinity : Number(min);
    const hi = max === "+inf" ? Infinity : Number(max);
    const kept = arr.filter((e) => !(e.score >= lo && e.score <= hi));
    this.store.set(key, kept);
    return arr.length - kept.length;
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const arr = (this.store.get(key) ?? [])
      .slice()
      .sort((a, b) => b.score - a.score);
    const end = stop < 0 ? arr.length : stop + 1;
    return arr.slice(start, end).map((e) => e.member);
  }

  async pexpire(): Promise<number> {
    return 1;
  }
}

const WINDOW_MS = 10_000;

describe("ActiveAppSlidesRepository", () => {
  let repo: ActiveAppSlidesRepository;

  beforeEach(() => {
    repo = new ActiveAppSlidesRepository(new FakeRedis() as never);
  });

  it("returns a recorded slide while it is inside the replay window", async () => {
    const payload = { slideId: 1, scope: "app", svgaUrl: "a.svga" };
    await repo.record(payload, 1_000);

    const active = await repo.getActive(1_500);
    expect(active).toEqual([payload]);
  });

  it("prunes a slide past the replay window", async () => {
    await repo.record({ slideId: 1 }, 0);

    // At exactly window end the slide has expired.
    expect(await repo.getActive(WINDOW_MS)).toEqual([]);
  });

  it("keeps slides distinct (no collision) and returns newest first", async () => {
    await repo.record({ slideId: 1 }, 1_000);
    await repo.record({ slideId: 2 }, 2_000);

    const active = await repo.getActive(3_000);
    expect(active).toEqual([{ slideId: 2 }, { slideId: 1 }]);
  });

  it("caps the number of slides replayed to a single joiner", async () => {
    for (let i = 0; i < 7; i++) {
      await repo.record({ slideId: i }, 1_000 + i);
    }

    const active = await repo.getActive(2_000);
    expect(active).toHaveLength(5);
    // Newest (highest id) first.
    expect((active[0] as { slideId: number }).slideId).toBe(6);
  });
});
