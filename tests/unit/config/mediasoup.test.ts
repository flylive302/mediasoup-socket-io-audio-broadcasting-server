/**
 * Router Opus codec (cost-and-speed-tuning 03): DTX advertised, FEC on, the
 * 10 ms floor kept so the client mic's 40 ms packets are its own choice.
 */
import { describe, expect, it } from "vitest";
import { mediasoupConfig } from "@src/config/mediasoup.js";

describe("mediasoupConfig.router Opus codec", () => {
  const opus = mediasoupConfig.router.mediaCodecs.find(
    (codec) => codec.mimeType === "audio/opus",
  );

  it("is the only router codec", () => {
    expect(mediasoupConfig.router.mediaCodecs).toHaveLength(1);
    expect(opus).toBeDefined();
  });

  it("advertises DTX, in-band FEC and a 10 ms minimum packet duration", () => {
    expect(opus?.parameters).toMatchObject({
      usedtx: 1,
      useinbandfec: 1,
      minptime: 10,
    });
  });
});
