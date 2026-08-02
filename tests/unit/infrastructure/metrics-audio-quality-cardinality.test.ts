/**
 * observability-audio-quality 01, AC #5.
 *
 * Drives a sampling tick, scrapes the real Prometheus endpoint and asserts
 * that NO series in the whole scrape body is keyed by a room, user, consumer
 * or producer. The cardinality rule is enforced by this test, not by
 * convention — MSAB has never had a label dimension keyed to a live, growing
 * entity set, and these are the first metrics that could introduce one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { config } from "@src/config/index.js";
import {
  createMetricsRoutes,
  metrics,
  metricsRegistry,
} from "@src/infrastructure/metrics.js";
import { runQualitySamplingTick } from "@src/domains/media/quality/qualitySampler.js";
import { scoreRegistry } from "@src/domains/media/quality/scoreRegistry.js";

/**
 * Values distinctive enough that finding any of them in the scrape body is
 * proof of a leak, not a coincidence.
 */
const CANARY_ROOM = "room-CARDINALITY-CANARY";
const CANARY_USER = "user-CARDINALITY-CANARY";
const CANARY_STREAM = "stream-CARDINALITY-CANARY";

/** Label keys that would each be a per-entity series explosion. */
const FORBIDDEN_LABEL_KEYS = [
  "room",
  "room_id",
  "roomid",
  "user",
  "user_id",
  "userid",
  "consumer",
  "consumer_id",
  "producer",
  "producer_id",
  "stream",
  "stream_id",
  "session",
  "session_id",
  "peer",
  "socket",
  "socket_id",
];

const roomManagerStub = { getRoomCount: () => 0 } as never;
const workerManagerStub = {
  getWorkerStats: () => [],
  getWorkerCount: () => 0,
  getExpectedWorkerCount: () => 0,
} as never;

const buildApp = async () => {
  const app = Fastify();
  await app.register(createMetricsRoutes(roomManagerStub, workerManagerStub));
  await app.ready();
  return app;
};

const scrape = async (app: Awaited<ReturnType<typeof buildApp>>) => {
  const response = await app.inject({
    method: "GET",
    url: "/metrics/prometheus",
    headers: { "x-internal-key": config.LARAVEL_INTERNAL_KEY },
  });
  expect(response.statusCode).toBe(200);
  return response.body;
};

/** Every distinct label key present anywhere in a Prometheus exposition. */
const labelKeysIn = (body: string): Set<string> => {
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const braces = line.match(/^[^{]+\{(.*)\}\s/);
    if (!braces?.[1]) continue;
    for (const match of braces[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)=/g)) {
      keys.add(match[1]!.toLowerCase());
    }
  }
  return keys;
};

describe("audio-quality metrics cardinality", () => {
  let originalInstanceId: string;

  beforeEach(() => {
    originalInstanceId = config.INSTANCE_ID;
    config.INSTANCE_ID = "i-test-instance";
    scoreRegistry.clear();
    metrics.audioQualityScore.reset();
    metrics.audioQualitySamples.reset();
  });

  afterEach(() => {
    config.INSTANCE_ID = originalInstanceId;
    scoreRegistry.clear();
    metrics.audioQualityScore.reset();
    metrics.audioQualitySamples.reset();
  });

  it("publishes no series keyed by room, user, consumer or producer", async () => {
    scoreRegistry.record({
      streamId: CANARY_STREAM,
      direction: "sending",
      score: 9,
      roomId: CANARY_ROOM,
      userId: CANARY_USER,
    });
    scoreRegistry.record({
      streamId: `${CANARY_STREAM}-2`,
      direction: "receiving",
      score: 3,
      roomId: CANARY_ROOM,
      userId: CANARY_USER,
    });

    runQualitySamplingTick();

    const app = await buildApp();
    const body = await scrape(app);
    await app.close();

    // No forbidden label key anywhere in the scrape — including the default
    // Node metrics, which share this registry.
    const present = labelKeysIn(body);
    for (const forbidden of FORBIDDEN_LABEL_KEYS) {
      expect(present.has(forbidden)).toBe(false);
    }

    // And no entity identity leaked as a label VALUE either.
    expect(body).not.toContain(CANARY_ROOM);
    expect(body).not.toContain(CANARY_USER);
    expect(body).not.toContain(CANARY_STREAM);
  });

  it("exposes the percentiles with only region, instance, direction and statistic", async () => {
    scoreRegistry.record({
      streamId: "p-1",
      direction: "sending",
      score: 10,
      roomId: CANARY_ROOM,
      userId: CANARY_USER,
    });

    runQualitySamplingTick();

    const app = await buildApp();
    const body = await scrape(app);
    await app.close();

    const series = body
      .split("\n")
      .filter((line) => line.startsWith("flylive_audio_quality_score{"));

    expect(series.length).toBe(6); // min, p01, p10, p50, p90, max
    for (const line of series) {
      expect(line).toContain(`region="${config.AWS_REGION}"`);
      expect(line).toContain('instance="i-test-instance"');
      expect(line).toContain('direction="sending"');
      expect(line).toMatch(/statistic="(min|p01|p10|p50|p90|max)"/);
    }

    expect(body).toContain(
      'flylive_audio_quality_samples{region="' +
        config.AWS_REGION +
        '",instance="i-test-instance",direction="sending"} 1',
    );
  });

  it("stops publishing a direction that went quiet instead of freezing its last value", async () => {
    scoreRegistry.record({
      streamId: "c-1",
      direction: "receiving",
      score: 2,
      roomId: CANARY_ROOM,
      userId: CANARY_USER,
    });
    runQualitySamplingTick();

    const app = await buildApp();
    expect(await scrape(app)).toContain('direction="receiving"');

    // Every leg closed. Without the reset, p50=2 would be published forever.
    scoreRegistry.clear();
    runQualitySamplingTick();

    const afterDrain = await scrape(app);
    await app.close();

    expect(afterDrain).not.toContain("flylive_audio_quality_score{");
    expect(afterDrain).not.toContain("flylive_audio_quality_samples{");
  });

  it("rejects an unauthenticated scrape", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/metrics/prometheus",
    });
    await app.close();

    expect(response.statusCode).toBe(401);
  });

  it("documents which audio legs the metric covers", async () => {
    const help = await metricsRegistry.getSingleMetricAsString(
      "flylive_audio_quality_score",
    );

    expect(help).toContain("direction=sending");
    expect(help).toContain("direction=receiving");
    expect(help).toContain("DOES NOT COVER");
  });
});
