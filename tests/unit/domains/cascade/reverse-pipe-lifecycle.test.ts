import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config/index.js", () => ({
  config: {
    LOG_LEVEL: "silent",
    PUBLIC_IP: "10.0.1.100",
    INTERNAL_API_KEY: "test-internal-key-12345678",
    INSTANCE_ID: "10.0.1.100",
  },
  isDev: false,
}));

import { ReversePipeLifecycle } from "@src/domains/cascade/reverse-pipe-lifecycle.js";

// dj-talk-over/07: the edge must tell origin whether the reverse-piped
// producer is mic or music (via `mediaSource` in the reverse-finalize body),
// otherwise an edge-hosted DJ's music collides with their mic on origin.

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockTransport() {
  return {
    close: vi.fn(),
    closed: false,
    observer: { on: vi.fn() },
  };
}

function createMockPipeManager(transport: ReturnType<typeof createMockTransport>) {
  return {
    createReverseOutboundTransport: vi
      .fn()
      .mockResolvedValue({ transport, ip: "10.0.2.2", port: 41000 }),
    connectReverseTransport: vi.fn().mockResolvedValue({
      consumer: {},
      consumerKind: "audio",
      consumerRtpParameters: { codecs: [], encodings: [] },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function mockFetchSequence() {
  const fetchMock = vi.fn();
  // Phase 2: reverse-offer response.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      status: "ok",
      transportId: "origin-transport-1",
      ip: "10.0.9.9",
      port: 42000,
      rtpCapabilities: { codecs: [] },
    }),
  });
  // Phase 4: reverse-finalize response.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ status: "ok", originProducerId: "origin-prod-1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runSetup(appDataSource: string | undefined) {
  const transport = createMockTransport();
  const pipeManager = createMockPipeManager(transport);
  const originUrls = new Map([["room-1", "http://10.0.9.9:3030"]]);
  const lifecycle = new ReversePipeLifecycle(pipeManager, originUrls, createMockLogger());
  const fetchMock = mockFetchSequence();

  const edgeProducer = {
    id: "edge-prod-A",
    appData: appDataSource === undefined ? {} : { source: appDataSource },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const result = await lifecycle.setupReversePipe(
    "room-1",
    edgeProducer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { router: {} } as any,
    42,
  );

  const finalizeCall = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("/internal/pipe/reverse-finalize"),
  );
  const finalizeBody = finalizeCall ? JSON.parse(finalizeCall[1].body as string) : null;
  return { result, finalizeBody };
}

describe("ReversePipeLifecycle — mediaSource threading (dj-talk-over/07)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("sends mediaSource=music when the edge producer is a music producer", async () => {
    const { result, finalizeBody } = await runSetup("music");
    expect(result).toEqual({ originProducerId: "origin-prod-1" });
    expect(finalizeBody).toMatchObject({
      roomId: "room-1",
      edgeProducerId: "edge-prod-A",
      userId: 42,
      mediaSource: "music",
    });
  });

  it("sends mediaSource=mic for a mic producer", async () => {
    const { finalizeBody } = await runSetup("mic");
    expect(finalizeBody).toMatchObject({ mediaSource: "mic" });
  });

  it("coerces a missing appData.source to mic (pre-feature producer)", async () => {
    const { finalizeBody } = await runSetup(undefined);
    expect(finalizeBody).toMatchObject({ mediaSource: "mic" });
  });
});
