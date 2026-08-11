// Real media, not signaling-only: speakers push actual 48 kHz PCM into
// libwebrtc's Opus encoder via wrtc's nonstandard RTCAudioSource; listeners
// attach an RTCAudioSink so every consumed leg is genuinely decoded, and
// libwebrtc emits real RTCP receiver reports back to the SFU (SLO doc §7.1 V4:
// a discard sink never returns RTCP and voids the RTP verdict).

import wrtc from '@roamhq/wrtc';

const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;

const SAMPLE_RATE = 48000;
const FRAME_MS = 10;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

// Speech-band tone with slow amplitude modulation so DTX/VAD paths see a
// realistic, always-active signal. Distinct frequency per bot avoids the
// pathological all-identical-streams case.
export function createSpeakerTrack(botId) {
  const source = new RTCAudioSource();
  const track = source.createTrack();
  const freq = 200 + (botId % 40) * 15;
  let t = 0;
  const samples = new Int16Array(SAMPLES_PER_FRAME);
  const timer = setInterval(() => {
    for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
      const mod = 0.55 + 0.45 * Math.sin((2 * Math.PI * 0.5 * (t + i)) / SAMPLE_RATE);
      samples[i] = Math.round(8000 * mod * Math.sin((2 * Math.PI * freq * (t + i)) / SAMPLE_RATE));
    }
    t += SAMPLES_PER_FRAME;
    source.onData({
      samples,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: SAMPLES_PER_FRAME,
    });
  }, FRAME_MS);
  return {
    track,
    stop() {
      clearInterval(timer);
      track.stop();
    },
  };
}

// Counts decoded frames so the fleet can prove audio actually flowed
// end-to-end (frames > 0 is the harness's own "real media" evidence).
export function attachSink(track, counters) {
  const sink = new RTCAudioSink(track);
  sink.ondata = () => {
    counters.audioFramesReceived += 1;
  };
  return sink;
}
