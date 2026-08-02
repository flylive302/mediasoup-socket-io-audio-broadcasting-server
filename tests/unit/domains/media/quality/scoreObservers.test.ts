import { describe, it, expect, beforeEach, vi } from "vitest";
import { RouterManager } from "@src/domains/media/routerManager.js";
import { scoreRegistry } from "@src/domains/media/quality/scoreRegistry.js";

const leg = { roomId: "room-9", userId: "123" };

/**
 * Minimal mediasoup stub exposing the emitter, its observer, and the sync
 * `paused` / `score` getters the observers read.
 */
const createStreamStub = (id: string) => {
  const on = new Map<string, (...args: unknown[]) => void>();
  const observerOn = new Map<string, (...args: unknown[]) => void>();
  return {
    id,
    paused: false,
    producerPaused: false,
    /** Shape differs by type: ProducerScore[] for producers, ConsumerScore for consumers. */
    score: undefined as unknown,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      on.set(event, handler);
    }),
    observer: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        observerOn.set(event, handler);
      }),
    },
    emit: (event: string, payload?: unknown) => on.get(event)?.(payload),
    emitObserver: (event: string) => observerOn.get(event)?.(),
  };
};

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

const newRouterManager = () =>
  new RouterManager({ appData: {} } as never, mockLogger);

describe("audio-quality score observers", () => {
  beforeEach(() => {
    scoreRegistry.clear();
  });

  describe("registerProducer", () => {
    it("records the sending leg's score from the SFU push", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-1");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 8 }]);

      expect(scoreRegistry.snapshot()).toEqual([
        {
          streamId: "p-1",
          direction: "sending",
          score: 8,
          roomId: "room-9",
          userId: "123",
        },
      ]);
    });

    it("takes the first encoding — the producer event is an array", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-2");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [
        { encodingIdx: 0, ssrc: 1, score: 6 },
        { encodingIdx: 1, ssrc: 2, score: 10 },
      ]);

      expect(scoreRegistry.snapshot()[0]?.score).toBe(6);
    });

    it("skips an empty score array instead of defaulting to zero", () => {
      // Zero is worst-possible quality; a synthetic one would dominate
      // min and p01.
      const rm = newRouterManager();
      const producer = createStreamStub("p-3");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", []);

      expect(scoreRegistry.size).toBe(0);
    });

    it("keeps only the latest score per leg", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-4");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 9 }]);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 3 }]);

      expect(scoreRegistry.size).toBe(1);
      expect(scoreRegistry.snapshot()[0]?.score).toBe(3);
    });

    it("does NOT sample a relay leg — no ClientLeg means no subscription", () => {
      const rm = newRouterManager();
      const pipeProducer = createStreamStub("pipe-1");

      rm.registerProducer(pipeProducer as never);

      expect(pipeProducer.on).not.toHaveBeenCalledWith(
        "score",
        expect.anything(),
      );
      expect(pipeProducer.observer.on).not.toHaveBeenCalled();
      expect(scoreRegistry.size).toBe(0);
    });
  });

  describe("registerConsumer", () => {
    it("records the receiving leg's own score, not the upstream producer's", () => {
      const rm = newRouterManager();
      const consumer = createStreamStub("c-1");

      rm.registerConsumer(consumer as never, leg);
      consumer.emit("score", {
        score: 7,
        producerScore: 10,
        producerScores: [10],
      });

      expect(scoreRegistry.snapshot()).toEqual([
        {
          streamId: "c-1",
          direction: "receiving",
          score: 7,
          roomId: "room-9",
          userId: "123",
        },
      ]);
    });

    it("does NOT sample a consumer registered without a ClientLeg", () => {
      const rm = newRouterManager();
      const consumer = createStreamStub("c-2");

      rm.registerConsumer(consumer as never);
      expect(consumer.observer.on).not.toHaveBeenCalled();
      expect(scoreRegistry.size).toBe(0);
    });
  });

  describe("close handling", () => {
    it("forgets a producer closed directly, with no transport teardown", () => {
      // producer.close() on unpublish never fires `transportclose`. A leg
      // left behind would keep feeding its last score into min/p01 forever.
      const rm = newRouterManager();
      const producer = createStreamStub("p-5");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 2 }]);
      expect(scoreRegistry.size).toBe(1);

      producer.emitObserver("close");
      expect(scoreRegistry.size).toBe(0);
    });

    it("forgets a consumer on observer close", () => {
      const rm = newRouterManager();
      const consumer = createStreamStub("c-3");

      rm.registerConsumer(consumer as never, leg);
      consumer.emit("score", { score: 4, producerScore: 9, producerScores: [9] });
      expect(scoreRegistry.size).toBe(1);

      consumer.emitObserver("close");
      expect(scoreRegistry.size).toBe(0);
    });
  });

  describe("paused legs", () => {
    // Mute is a normal steady state here, and every listener consumer is
    // created paused. A paused leg carries no audio, so counting it would let
    // mute alone pin min/p01 near zero.
    it("does not record a muted producer", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-7");
      producer.paused = true;

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 1 }]);

      expect(scoreRegistry.size).toBe(0);
    });

    it("drops an already-recorded producer when it is muted", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-8");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 9 }]);
      expect(scoreRegistry.size).toBe(1);

      producer.paused = true;
      producer.emitObserver("pause");
      expect(scoreRegistry.size).toBe(0);
    });

    it("re-records a producer on resume without waiting for the score to change", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-9");

      rm.registerProducer(producer as never, leg);
      producer.paused = true;
      producer.emitObserver("pause");

      producer.paused = false;
      producer.score = [{ encodingIdx: 0, ssrc: 1, score: 7 }];
      producer.emitObserver("resume");

      expect(scoreRegistry.snapshot()[0]?.score).toBe(7);
    });

    it("does not record a consumer paused at either end", () => {
      const rm = newRouterManager();
      const consumer = createStreamStub("c-4");
      // Every listener consumer is born paused (roomMediaCluster).
      consumer.paused = true;

      rm.registerConsumer(consumer as never, leg);
      consumer.emit("score", { score: 1, producerScore: 1, producerScores: [1] });
      expect(scoreRegistry.size).toBe(0);

      consumer.paused = false;
      consumer.producerPaused = true;
      consumer.emit("score", { score: 1, producerScore: 1, producerScores: [1] });
      expect(scoreRegistry.size).toBe(0);
    });

    it("drops a consumer when its upstream speaker mutes, and restores it on resume", () => {
      const rm = newRouterManager();
      const consumer = createStreamStub("c-5");

      rm.registerConsumer(consumer as never, leg);
      consumer.emit("score", { score: 8, producerScore: 8, producerScores: [8] });
      expect(scoreRegistry.size).toBe(1);

      consumer.producerPaused = true;
      consumer.emit("producerpause");
      expect(scoreRegistry.size).toBe(0);

      consumer.producerPaused = false;
      consumer.score = { score: 6, producerScore: 6, producerScores: [6] };
      consumer.emit("producerresume");
      expect(scoreRegistry.snapshot()[0]?.score).toBe(6);
    });

    it("resuming a consumer whose producer is still muted records nothing", () => {
      const rm = newRouterManager();
      const consumer = createStreamStub("c-6");
      consumer.producerPaused = true;
      consumer.score = { score: 9, producerScore: 9, producerScores: [9] };

      rm.registerConsumer(consumer as never, leg);
      consumer.emitObserver("resume");

      expect(scoreRegistry.size).toBe(0);
    });
  });

  describe("snapshot isolation", () => {
    it("returns a copy the aggregator cannot use to reach live state", () => {
      const rm = newRouterManager();
      const producer = createStreamStub("p-6");

      rm.registerProducer(producer as never, leg);
      producer.emit("score", [{ encodingIdx: 0, ssrc: 1, score: 5 }]);

      const snapshot = scoreRegistry.snapshot();
      snapshot.length = 0;

      expect(scoreRegistry.size).toBe(1);
    });
  });
});
