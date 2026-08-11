// Child process hosting a shard of bots. libwebrtc runs native threads per
// peer connection, so the fleet spreads bots across processes; the parent
// (run.mjs) assigns bots and polls counters over IPC.

import { Bot } from './bot.mjs';

const bots = new Map();
const counters = {
  botsConnected: 0,
  consumersActive: 0,
  audioFramesReceived: 0,
  errors: 0,
  joinLatenciesMs: [],
};

process.on('message', async (msg) => {
  if (msg.cmd === 'add') {
    for (const spec of msg.bots) {
      const bot = new Bot({ ...spec, counters, log: (line) => process.send({ type: 'log', line }) });
      bots.set(spec.id, bot);
      bot.start().catch((e) => {
        counters.errors += 1;
        process.send({ type: 'log', line: `bot ${spec.id} start failed: ${e.message}` });
      });
      // Stagger joins so a ramp step doesn't burst-flood signaling (Q12 is a
      // harness self-check; flooding is a harness bug).
      await new Promise((r) => setTimeout(r, msg.staggerMs ?? 150));
    }
    process.send({ type: 'added' });
  } else if (msg.cmd === 'stats') {
    process.send({ type: 'stats', counters: { ...counters, joinLatenciesMs: [...counters.joinLatenciesMs] } });
  } else if (msg.cmd === 'stop') {
    await Promise.allSettled([...bots.values()].map((b) => b.stop()));
    process.send({ type: 'stopped' });
    process.exit(0);
  }
});

process.send({ type: 'ready' });
