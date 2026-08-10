/**
 * Ticket 26 — SQS queue consumer through the event-ingest seam.
 *
 * The first describe is the SHARED behavioural suite: the same assertions run
 * against BOTH transports (HTTP route + queue consumer), so a divergence
 * between them fails a test, not a production room.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    LARAVEL_INTERNAL_KEY: "test-internal-key",
    INSTANCE_ID: "i-test-box-1",
    AWS_REGION: "ap-south-1",
    EVENT_QUEUE_URL: "",
  },
}));

import Fastify from "fastify";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { createEventIngestRoutes, ingestEnvelope } from "@src/infrastructure/event-ingest.js";
import { QueueConsumer, createQueueConsumer } from "@src/infrastructure/queue-consumer.js";
import { config } from "@src/config/index.js";

const QUEUE_URL = "https://sqs.ap-south-1.amazonaws.com/1/test.fifo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function makeEnvelope(n: number) {
  return {
    event: `e-${n}`,
    user_id: null,
    room_id: null,
    payload: {},
    timestamp: new Date().toISOString(),
    correlation_id: `c-${n}`,
  };
}

/**
 * Fake SQS client: serves queued receive batches, then parks on a promise
 * that rejects when stop() aborts the long poll. Records deletes.
 */
function makeFakeSqs(batches: unknown[][]) {
  const deletes: string[] = [];
  const pending = [...batches];
  const client = {
    send: vi.fn(
      (
        command: unknown,
        options?: { abortSignal?: AbortSignal },
      ): Promise<unknown> => {
        if (command instanceof ReceiveMessageCommand) {
          const batch = pending.shift();
          if (batch) {
            return Promise.resolve({
              Messages: batch.map((body, i) => ({
                MessageId: `m-${deletes.length}-${i}`,
                ReceiptHandle: `rh-${JSON.stringify(body).length}-${i}`,
                Body: typeof body === "string" ? body : JSON.stringify(body),
              })),
            });
          }
          // Park until aborted (simulates the 20s long poll).
          return new Promise((_, reject) => {
            options?.abortSignal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
        }
        if (command instanceof DeleteMessageCommand) {
          deletes.push(
            (command as DeleteMessageCommand).input.ReceiptHandle ?? "",
          );
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
    ),
  } as unknown as SQSClient;
  return { client, deletes };
}

/** Run a consumer over the given batches until `until` holds, then stop it. */
async function runConsumer(
  batches: unknown[][],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventRouter: any,
  until: () => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis?: any,
) {
  const { client, deletes } = makeFakeSqs(batches);
  const consumer = new QueueConsumer(
    QUEUE_URL,
    eventRouter,
    mockLogger,
    redis,
    client,
  );
  consumer.start();
  await vi.waitFor(until);
  await consumer.stop();
  return { deletes };
}

// ─── Shared behavioural suite: SAME assertions, both transports ─────────────

type Delivery = { routed: boolean };

interface TransportAdapter {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deliver(body: unknown, eventRouter: any, redis?: any): Promise<Delivery>;
}

const httpTransport: TransportAdapter = {
  name: "http",
  async deliver(body, eventRouter, redis) {
    const app = Fastify({ logger: false });
    await app.register(createEventIngestRoutes(eventRouter, redis));
    await app.ready();
    const callsBefore = eventRouter.route.mock.calls.length;
    await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "x-internal-key": "test-internal-key" },
      payload: body as object,
    });
    await app.close();
    return { routed: eventRouter.route.mock.calls.length > callsBefore };
  },
};

const queueTransport: TransportAdapter = {
  name: "queue",
  async deliver(body, eventRouter, redis) {
    const callsBefore = eventRouter.route.mock.calls.length;
    const { client } = makeFakeSqs([[body]]);
    const consumer = new QueueConsumer(
      QUEUE_URL,
      eventRouter,
      mockLogger,
      redis,
      client,
    );
    consumer.start();
    // Wait until the batch has been consumed (receive called twice = batch done).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await vi.waitFor(() => expect((client as any).send.mock.calls.length).toBeGreaterThanOrEqual(2));
    await consumer.stop();
    return { routed: eventRouter.route.mock.calls.length > callsBefore };
  },
};

describe.each([httpTransport, queueTransport])(
  "ingest seam behaviour via $name transport",
  (transport) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let eventRouter: any;

    beforeEach(() => {
      vi.clearAllMocks();
      eventRouter = {
        route: vi.fn(async () => ({ delivered: true, targetCount: 1 })),
      };
    });

    it("routes a valid envelope through eventRouter exactly once", async () => {
      const { routed } = await transport.deliver(makeEnvelope(1), eventRouter);
      expect(routed).toBe(true);
      expect(eventRouter.route).toHaveBeenCalledTimes(1);
      expect(eventRouter.route.mock.calls[0][0].event).toBe("e-1");
    });

    it("never routes a schema-invalid envelope", async () => {
      const { routed } = await transport.deliver(
        { not_an_event: true },
        eventRouter,
      );
      expect(routed).toBe(false);
      expect(eventRouter.route).not.toHaveBeenCalled();
    });

    it("suppresses a duplicate via the dedup gate (redelivery is normal)", async () => {
      // Fake redis: first NX claim wins, second loses.
      const redis = {
        set: vi
          .fn()
          .mockResolvedValueOnce("OK")
          .mockResolvedValue(null),
        del: vi.fn().mockResolvedValue(1),
      };
      const envelope = makeEnvelope(2);
      await transport.deliver(envelope, eventRouter, redis);
      await transport.deliver(envelope, eventRouter, redis);
      expect(eventRouter.route).toHaveBeenCalledTimes(1);
    });
  },
);

// ─── Queue-transport-specific semantics ─────────────────────────────────────

describe("QueueConsumer transport semantics", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let eventRouter: any;

  beforeEach(() => {
    vi.clearAllMocks();
    eventRouter = {
      route: vi.fn(async () => ({ delivered: true, targetCount: 1 })),
    };
  });

  it("deletes a successfully routed message", async () => {
    const { deletes } = await runConsumer(
      [[makeEnvelope(1)]],
      eventRouter,
      () => expect(eventRouter.route).toHaveBeenCalledTimes(1),
    );
    expect(deletes).toHaveLength(1);
  });

  it("deletes a duplicate (terminal outcome — already applied once)", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null), // claim always lost = duplicate
      del: vi.fn(),
    };
    const { deletes } = await runConsumer(
      [[makeEnvelope(1)]],
      eventRouter,
      () => expect(mockLogger.info).toHaveBeenCalledWith(
        expect.anything(),
        "Event ingest: duplicate suppressed",
      ),
      redis,
    );
    expect(eventRouter.route).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(1);
  });

  it("does NOT delete a schema-invalid message — it must reach the DLQ", async () => {
    const { deletes } = await runConsumer(
      [[{ garbage: true }]],
      eventRouter,
      () => expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.anything(),
        "Queue consumer: schema-invalid envelope — leaving for DLQ",
      ),
    );
    expect(deletes).toHaveLength(0);
  });

  it("does NOT delete when routing throws — message redelivers", async () => {
    eventRouter.route.mockRejectedValue(new Error("router exploded"));
    const { deletes } = await runConsumer(
      [[makeEnvelope(1)]],
      eventRouter,
      () => expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.anything(),
        "Queue consumer: routing failed — leaving message for redelivery",
      ),
    );
    expect(deletes).toHaveLength(0);
  });

  it("at capacity, leaves the message undeleted and does not route it (backpressure = queue depth)", async () => {
    // Saturate the SHARED concurrency cap through the seam directly.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hangingRouter = {
      route: vi.fn(async () => { await gate; return { delivered: true, targetCount: 1 }; }),
    };
    const held = Array.from({ length: 100 }, (_, i) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ingestEnvelope(makeEnvelope(1000 + i), { eventRouter: hangingRouter as any, log: mockLogger }),
    );
    await vi.waitFor(() => expect(hangingRouter.route).toHaveBeenCalledTimes(100));

    const { deletes } = await runConsumer(
      [[makeEnvelope(1)]],
      eventRouter,
      () => expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.anything(),
        "Event ingest at capacity — shedding",
      ),
    );
    expect(eventRouter.route).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(0);

    release();
    await Promise.all(held);
  });

  it("stop() finishes the in-flight message before returning (graceful drain)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let routeFinished = false;
    eventRouter.route.mockImplementation(async () => {
      await gate;
      routeFinished = true;
      return { delivered: true, targetCount: 1 };
    });

    const { client, deletes } = makeFakeSqs([[makeEnvelope(1)]]);
    const consumer = new QueueConsumer(QUEUE_URL, eventRouter, mockLogger, undefined, client);
    consumer.start();
    await vi.waitFor(() => expect(eventRouter.route).toHaveBeenCalledTimes(1));

    const stopPromise = consumer.stop();
    let stopped = false;
    void stopPromise.then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // still draining the in-flight message

    release();
    await stopPromise;
    expect(routeFinished).toBe(true);
    expect(deletes).toHaveLength(1); // the in-flight message completed + deleted
  });

  it("createQueueConsumer is null when EVENT_QUEUE_URL is unset (inert by default)", () => {
    expect(config.EVENT_QUEUE_URL).toBe("");
    expect(
      createQueueConsumer({ eventRouter, logger: mockLogger }),
    ).toBeNull();
  });
});
