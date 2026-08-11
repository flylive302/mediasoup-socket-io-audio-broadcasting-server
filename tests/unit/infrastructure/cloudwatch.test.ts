/**
 * ticket 32 pt.2 / pt.6 — CloudWatch publisher.
 *
 * Covers:
 *  - the fixed defect: ReversePipeSetupSuccess, ReversePipeSetupFailure and
 *    MaxRoomListeners now publish a dimensionless twin. They previously
 *    shipped dimensioned-only, so the `reverse_pipe_failure_rate` Terraform
 *    alarm (queried with no dimensions block — see
 *    terraform/modules/cloudwatch/main.tf) read an empty stream and could
 *    never fire; `treat_missing_data = "notBreaching"` made that look
 *    healthy.
 *  - the five registry metrics bridged into CloudWatch in pt.2.
 *  - the six HLS/broadcast-transcoder registry metrics bridged in pt.6
 *    (flylive_hls_* — see metrics.ts), including that
 *    HlsPublisherExitsUnexpected reads ONLY the `reason="unexpected"` label
 *    (an "expected" exit is our own SIGKILL and must never page anyone) and
 *    that HlsUploaderFailuresTotal sums across every `operation` label.
 *  - the general rule, so the defect can't reappear one metric at a time:
 *    EVERY metric this file publishes must have BOTH a dimensioned and a
 *    dimensionless entry, because CloudWatch alarms can't SEARCH() or
 *    enumerate per-instance dimensions — a fleet-wide alarm can only read
 *    the dimensionless stream (cloudwatch.ts `pair()`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMock = vi.fn().mockResolvedValue({});
const putMetricDataCommandMock = vi.fn().mockImplementation((input: unknown) => ({ input }));

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutMetricDataCommand: putMetricDataCommandMock,
}));

// Partial mock, same shape as worker.manager.test.ts's — none of prom-client's
// default metrics touch the `os` module directly (verified: nothing under
// prom-client/lib requires "os"), so only the two fields cloudwatch.ts's own
// WorkerCPU calculation reads are needed.
vi.mock("os", () => ({
  cpus: vi.fn(() => [{}, {}]),
  loadavg: vi.fn(() => [1, 1, 1]),
}));

import { config } from "@src/config/index.js";
import { metrics } from "@src/infrastructure/metrics.js";
import {
  startCloudWatchPublisher,
  stopCloudWatchPublisher,
} from "@src/infrastructure/cloudwatch.js";

interface MetricDatum {
  MetricName: string;
  Value: number;
  Unit: string;
  Timestamp: Date;
  Dimensions?: { Name: string; Value: string }[];
}

const roomManagerStub = {
  getRoomCount: () => 3,
  getMaxRoomListeners: () => 42,
} as never;

const workerManagerStub = {
  getWorkerCount: () => 2,
  getWorkerStats: () => [
    { pid: 111, routerCount: 4 },
    { pid: 222, routerCount: 9 },
  ],
} as never;

/**
 * Every MetricName this file publishes today. Any fleet-wide alarm can only
 * read the dimensionless stream, so every one of these must have both a
 * dimensioned and a dimensionless datapoint — see the second test below.
 */
const FLEET_ALARM_METRICS = [
  "ActiveRooms",
  "ActiveConnections",
  "WorkerCount",
  "WorkerCPU",
  "MaxRoomListeners",
  "ReversePipeSetupSuccess",
  "ReversePipeSetupFailure",
  "EventLoopLagP99Seconds",
  "RoutersPerWorkerMax",
  "RedisDegradationTotal",
  "SocketRegistrationFailures",
  "SentryDroppedTotal",
  "HlsPublishersActive",
  "HlsPublisherExitsUnexpected",
  "HlsMixerPortsInUse",
  "HlsMixerPortsCapacity",
  "HlsMixerPortExhaustedTotal",
  "HlsUploaderFailuresTotal",
];

const resetRegistry = () => {
  metrics.socketConnections.set(0);
  metrics.reversePipeSetup.reset();
  metrics.routersPerWorker.reset();
  metrics.redisDegradations.reset();
  metrics.socketRegistrationFailures.reset();
  metrics.sentryDropped.reset();
  metrics.hlsPublishersActive.reset();
  metrics.hlsPublisherExits.reset();
  metrics.hlsMixerPortsInUse.reset();
  metrics.hlsMixerPortsCapacity.reset();
  metrics.hlsMixerPortExhausted.reset();
  metrics.hlsUploaderFailures.reset();
};

describe("CloudWatch metrics publisher", () => {
  let originalInstanceId: string;
  let originalCloudwatchEnabled: string | undefined;

  beforeEach(() => {
    originalInstanceId = config.INSTANCE_ID;
    config.INSTANCE_ID = "i-test-cloudwatch";
    originalCloudwatchEnabled = process.env.CLOUDWATCH_ENABLED;
    delete process.env.CLOUDWATCH_ENABLED;
    sendMock.mockClear();
    putMetricDataCommandMock.mockClear();
    resetRegistry();
  });

  afterEach(() => {
    stopCloudWatchPublisher();
    config.INSTANCE_ID = originalInstanceId;
    if (originalCloudwatchEnabled === undefined) {
      delete process.env.CLOUDWATCH_ENABLED;
    } else {
      process.env.CLOUDWATCH_ENABLED = originalCloudwatchEnabled;
    }
    resetRegistry();
  });

  /** Starts the publisher (which publishes once immediately) and returns the MetricData it sent. */
  const publishOnce = async (): Promise<MetricDatum[]> => {
    await startCloudWatchPublisher(roomManagerStub, workerManagerStub);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = putMetricDataCommandMock.mock.calls[0]?.[0] as {
      Namespace: string;
      MetricData: MetricDatum[];
    };
    expect(input.Namespace).toBe("FlyLive/MSAB");
    return input.MetricData;
  };

  it("publishes the fixed defect metrics with BOTH a dimensioned and dimensionless entry", async () => {
    metrics.reversePipeSetup.inc({ result: "success" }, 7);
    metrics.reversePipeSetup.inc({ result: "failure" }, 2);

    const metricData = await publishOnce();

    for (const name of ["ReversePipeSetupSuccess", "ReversePipeSetupFailure", "MaxRoomListeners"]) {
      const entries = metricData.filter((d) => d.MetricName === name);
      expect(entries.length, `${name} should publish exactly 2 datapoints`).toBe(2);

      const dimensioned = entries.find((d) => d.Dimensions && d.Dimensions.length > 0);
      const dimensionless = entries.find((d) => !d.Dimensions || d.Dimensions.length === 0);
      expect(dimensioned, `${name} missing dimensioned datapoint`).toBeDefined();
      expect(dimensionless, `${name} missing dimensionless datapoint`).toBeDefined();
      expect(dimensioned!.Dimensions).toEqual([
        { Name: "InstanceId", Value: "i-test-cloudwatch" },
      ]);
      // Same value on both sides of the twin — the dimensionless copy isn't
      // some other computation, it's the same datapoint written twice.
      expect(dimensioned!.Value).toBe(dimensionless!.Value);
    }

    const success = metricData.find(
      (d) => d.MetricName === "ReversePipeSetupSuccess" && d.Dimensions,
    );
    const failure = metricData.find(
      (d) => d.MetricName === "ReversePipeSetupFailure" && d.Dimensions,
    );
    expect(success!.Value).toBe(7);
    expect(failure!.Value).toBe(2);

    const maxListeners = metricData.find(
      (d) => d.MetricName === "MaxRoomListeners" && d.Dimensions,
    );
    expect(maxListeners!.Value).toBe(42);
  });

  it("gives every fleet-alarm-eligible metric both a dimensioned and a dimensionless entry", async () => {
    // Drive every source so a metric that's only asymmetric when non-zero
    // (unlikely, but this is the assertion guarding against the regression)
    // can't hide behind an all-zeros publish.
    metrics.reversePipeSetup.inc({ result: "success" }, 1);
    metrics.reversePipeSetup.inc({ result: "failure" }, 1);
    metrics.redisDegradations.inc({ subsystem: "gift", operation: "read" }, 3);
    metrics.socketRegistrationFailures.inc(1);
    metrics.sentryDropped.inc(4);
    metrics.hlsPublishersActive.set(3);
    metrics.hlsPublisherExits.inc({ reason: "expected" }, 2);
    metrics.hlsPublisherExits.inc({ reason: "unexpected" }, 1);
    metrics.hlsMixerPortsInUse.set(5);
    metrics.hlsMixerPortsCapacity.set(100);
    metrics.hlsMixerPortExhausted.inc(2);
    metrics.hlsUploaderFailures.inc({ operation: "object_upload" }, 1);
    metrics.hlsUploaderFailures.inc({ operation: "room_cleanup" }, 1);

    const metricData = await publishOnce();

    // Derived from the ACTUAL payload, not the FLEET_ALARM_METRICS constant —
    // a hardcoded list would pass even if a 13th metric were added
    // dimensioned-only next month, which is exactly the defect this test
    // exists to catch. ⛔ A dimensioned-only metric here is a deliberate
    // act: if one is ever intentionally added (e.g. something no fleet
    // alarm will ever need), it must be excluded explicitly below with a
    // comment saying why, never silently.
    const publishedNames = [...new Set(metricData.map((d) => d.MetricName))];
    for (const name of publishedNames) {
      const entries = metricData.filter((d) => d.MetricName === name);
      expect(entries.length, `${name} should publish exactly 2 datapoints`).toBe(2);

      const dimensionedCount = entries.filter(
        (d) => d.Dimensions && d.Dimensions.length > 0,
      ).length;
      const dimensionlessCount = entries.filter(
        (d) => !d.Dimensions || d.Dimensions.length === 0,
      ).length;
      expect(dimensionedCount, `${name} missing its dimensioned datapoint`).toBe(1);
      expect(dimensionlessCount, `${name} missing its dimensionless datapoint`).toBe(1);
    }

    // Pin the roster too, so a metric can't silently vanish from the publish
    // (which the per-name loop above would miss entirely, having nothing
    // left to iterate).
    expect(publishedNames.sort()).toEqual([...FLEET_ALARM_METRICS].sort());
  });

  it("bridges the five new registry metrics with correct values", async () => {
    metrics.redisDegradations.inc({ subsystem: "gift", operation: "read" }, 3);
    metrics.redisDegradations.inc({ subsystem: "room", operation: "write" }, 5);
    metrics.socketRegistrationFailures.inc(9);
    metrics.sentryDropped.inc(6);

    const metricData = await publishOnce();

    const redisTotal = metricData.find(
      (d) => d.MetricName === "RedisDegradationTotal" && d.Dimensions,
    );
    expect(redisTotal!.Value).toBe(8); // 3 + 5, summed across label combinations
    expect(redisTotal!.Unit).toBe("Count");

    const socketFailures = metricData.find(
      (d) => d.MetricName === "SocketRegistrationFailures" && d.Dimensions,
    );
    expect(socketFailures!.Value).toBe(9);

    const sentryDropped = metricData.find(
      (d) => d.MetricName === "SentryDroppedTotal" && d.Dimensions,
    );
    expect(sentryDropped!.Value).toBe(6);

    const routersMax = metricData.find(
      (d) => d.MetricName === "RoutersPerWorkerMax" && d.Dimensions,
    );
    expect(routersMax!.Value).toBe(9); // max(4, 9) from workerManagerStub's two workers
    expect(routersMax!.Unit).toBe("Count");

    const eventLoopLag = metricData.find(
      (d) => d.MetricName === "EventLoopLagP99Seconds" && d.Dimensions,
    );
    expect(eventLoopLag).toBeDefined();
    expect(eventLoopLag!.Unit).toBe("Seconds");
    expect(typeof eventLoopLag!.Value).toBe("number");
    expect(eventLoopLag!.Value).toBeGreaterThanOrEqual(0);
  });

  it("bridges the six new HLS/broadcast registry metrics with correct values", async () => {
    metrics.hlsPublishersActive.set(3);
    // Both reasons incremented, at DIFFERENT values, so summing them (7) or
    // reading the wrong label (2, "expected") would both be caught —
    // published value must be exactly the "unexpected" one (5).
    metrics.hlsPublisherExits.inc({ reason: "expected" }, 2);
    metrics.hlsPublisherExits.inc({ reason: "unexpected" }, 5);
    metrics.hlsMixerPortsInUse.set(17);
    metrics.hlsMixerPortsCapacity.set(200);
    metrics.hlsMixerPortExhausted.inc(4);
    metrics.hlsUploaderFailures.inc({ operation: "object_upload" }, 3);
    metrics.hlsUploaderFailures.inc({ operation: "room_cleanup" }, 6);

    const metricData = await publishOnce();

    const publishersActive = metricData.find(
      (d) => d.MetricName === "HlsPublishersActive" && d.Dimensions,
    );
    expect(publishersActive!.Value).toBe(3);
    expect(publishersActive!.Unit).toBe("Count");

    // The load-bearing assertion: only the unexpected-exit value is
    // published, never the sum (7) and never the expected-only value (2).
    const exitsUnexpected = metricData.find(
      (d) => d.MetricName === "HlsPublisherExitsUnexpected" && d.Dimensions,
    );
    expect(exitsUnexpected!.Value).toBe(5);

    const portsInUse = metricData.find(
      (d) => d.MetricName === "HlsMixerPortsInUse" && d.Dimensions,
    );
    expect(portsInUse!.Value).toBe(17);

    const portsCapacity = metricData.find(
      (d) => d.MetricName === "HlsMixerPortsCapacity" && d.Dimensions,
    );
    expect(portsCapacity!.Value).toBe(200);

    const portsExhausted = metricData.find(
      (d) => d.MetricName === "HlsMixerPortExhaustedTotal" && d.Dimensions,
    );
    expect(portsExhausted!.Value).toBe(4);

    // Summed across both operation label values (3 + 6 = 9), not just one.
    const uploaderFailures = metricData.find(
      (d) => d.MetricName === "HlsUploaderFailuresTotal" && d.Dimensions,
    );
    expect(uploaderFailures!.Value).toBe(9);
  });

  it("publishes zero, not nothing, for a registry metric with no series yet", async () => {
    const metricData = await publishOnce();

    // RoutersPerWorkerMax excluded: it's recomputed fresh from
    // workerManagerStub every publish (that's the freshness fix), not from a
    // Prometheus counter/gauge this test resets — the stub always reports
    // two workers, so it's never the "no series" case being tested here.
    for (const name of [
      "RedisDegradationTotal",
      "SocketRegistrationFailures",
      "SentryDroppedTotal",
      "ReversePipeSetupSuccess",
      "ReversePipeSetupFailure",
      "HlsPublishersActive",
      "HlsPublisherExitsUnexpected",
      "HlsMixerPortsInUse",
      "HlsMixerPortsCapacity",
      "HlsMixerPortExhaustedTotal",
      "HlsUploaderFailuresTotal",
    ]) {
      const entry = metricData.find((d) => d.MetricName === name && d.Dimensions);
      expect(entry, `${name} should still publish a datapoint`).toBeDefined();
      expect(entry!.Value).toBe(0);
    }
  });

  it("reflects a live worker restructure — RoutersPerWorkerMax is not a stale leftover", async () => {
    // First publish establishes a baseline the way a fresh registry would.
    await publishOnce();

    // Swap in a worker manager whose stats changed since the first tick —
    // if RoutersPerWorkerMax were reading a stale gauge (only refreshed by
    // a Prometheus scrape nobody triggered), this would still show the old
    // max instead of the new one.
    sendMock.mockClear();
    putMetricDataCommandMock.mockClear();
    stopCloudWatchPublisher();

    const changedWorkerManagerStub = {
      getWorkerCount: () => 1,
      getWorkerStats: () => [{ pid: 333, routerCount: 21 }],
    } as never;

    await startCloudWatchPublisher(roomManagerStub, changedWorkerManagerStub);
    const input = putMetricDataCommandMock.mock.calls[0]?.[0] as {
      MetricData: MetricDatum[];
    };
    const routersMax = input.MetricData.find(
      (d) => d.MetricName === "RoutersPerWorkerMax" && d.Dimensions,
    );
    expect(routersMax!.Value).toBe(21);
  });

  it("keeps a single PutMetricDataCommand call per publish tick", async () => {
    await publishOnce();
    expect(putMetricDataCommandMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not change the existing metric names, namespace or dimension shape", async () => {
    const metricData = await publishOnce();
    const names = new Set(metricData.map((d) => d.MetricName));

    for (const preExisting of [
      "ActiveRooms",
      "ActiveConnections",
      "WorkerCount",
      "WorkerCPU",
      "MaxRoomListeners",
      "ReversePipeSetupSuccess",
      "ReversePipeSetupFailure",
    ]) {
      expect(names.has(preExisting)).toBe(true);
    }

    const dimensioned = metricData.filter((d) => d.Dimensions && d.Dimensions.length > 0);
    for (const d of dimensioned) {
      expect(d.Dimensions).toEqual([{ Name: "InstanceId", Value: "i-test-cloudwatch" }]);
    }
  });
});
