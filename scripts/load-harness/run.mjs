#!/usr/bin/env node
// Entry point. Ramps rooms × listeners on the configured schedule against the
// dedicated load-test environment, holds each step, then records epic 2's SLO
// queries (queries.mjs) NEXT TO fleet throughput (recorder.mjs) — ticket 34.
//
// Usage:
//   LOAD_HARNESS_ALLOW_TARGET=<host> LOAD_JWT_SECRET=<secret> node run.mjs --config config.json
//
// The run directory (runs/<timestamp>/) is the deliverable: steps.jsonl +
// SUMMARY.md. Same config against two instance sizes ⇒ directly comparable
// runs (ticket 35's input).

import { fork } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { assertSafeTarget } from './src/guard.mjs';
import { mintToken } from './src/token.mjs';
import { PromClient } from './src/prom.mjs';
import { evaluateStep, evaluateSignalling } from './src/queries.mjs';
import { RunRecorder } from './src/recorder.mjs';

const { values: argv } = parseArgs({
  options: {
    config: { type: 'string', default: 'config.json' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const config = JSON.parse(readFileSync(argv.config, 'utf8'));
assertSafeTarget(config);

const jwtSecret = process.env.LOAD_JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('LOAD_JWT_SECRET (the load-test environment JWT secret, ≥32 chars) is required.');
}

// Fail at second 0, not after the first hold. A wrong (or missing) region makes
// every audio query match zero series, which reads as VOID — and the ramp only
// discovers that AFTER holding the step, so a bad value costs a full holdSeconds
// and writes no SUMMARY.md. Cheap to check now.
const region = config.target.region;
if (!region) {
  throw new Error(
    'config.target.region is required — the value MSAB puts on the `region` label of the six ' +
      'audio series (its AWS_REGION, e.g. "ap-south-1"). Confirm it against the live scrape:\n' +
      "  curl -s -H \"X-Internal-Key: $KEY\" http://<host>:3030/metrics/prometheus \\\n" +
      "    | grep -o 'region=\"[^\"]*\"' | sort -u"
  );
}

const prom = new PromClient(config.prometheus.url);
const holdSeconds = config.ramp.holdSeconds ?? 600;
if (holdSeconds < 600) {
  // SLO doc §7.0 rule 4: a load level only counts after 10 sustained minutes.
  console.warn(`⚠️ holdSeconds=${holdSeconds} < 600 — this run cannot certify a capacity level.`);
}

const runDir = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(runDir, { recursive: true });
const recorder = new RunRecorder(runDir, { config, argv });

const workers = [];
const workerCount = config.fleet?.processes ?? 4;
let nextBotId = 1;
let assignedRooms = 0;

function spawnWorkers() {
  for (let i = 0; i < workerCount; i++) {
    const w = fork(new URL('./src/fleet-worker.mjs', import.meta.url), { stdio: 'inherit' });
    w.on('message', (m) => {
      if (m.type === 'log') console.log(`[worker ${i}] ${m.line}`);
    });
    workers.push(w);
  }
}

function workerCall(w, msg, replyType) {
  return new Promise((resolve) => {
    const onMsg = (m) => {
      if (m.type === replyType) {
        w.off('message', onMsg);
        resolve(m);
      }
    };
    w.on('message', onMsg);
    w.send(msg);
  });
}

// Rooms this run has already populated, and how many listeners each holds.
// scaleTo must top existing rooms UP to the new listenersPerRoom, not only
// create new rooms — found 2026-08-13 (ramp A, first multi-step run): without
// this, step N's "18×45" actually delivered 4@10 + 2@15 + … + 2@45, and the
// recorded load was 496 bots where the config said 846.
const roomListenerCounts = new Map();

async function scaleTo(rooms, listenersPerRoom, speakersPerRoom) {
  const specs = [];
  for (let r = 0; r < rooms; r++) {
    const roomId = `${config.ramp.roomPrefix ?? 'load-room'}-${r}`;
    if (r >= assignedRooms) {
      for (let s = 0; s < speakersPerRoom; s++) {
        specs.push({ roomId, role: 'speaker', seatIndex: s + 1 });
      }
    }
    const current = roomListenerCounts.get(roomId) ?? 0;
    for (let l = current; l < listenersPerRoom; l++) {
      specs.push({ roomId, role: 'listener' });
    }
    if (listenersPerRoom > current) roomListenerCounts.set(roomId, listenersPerRoom);
  }
  assignedRooms = Math.max(assignedRooms, rooms);

  const perWorker = workers.map(() => []);
  specs.forEach((spec, i) => {
    const id = nextBotId++;
    perWorker[i % workers.length].push({
      ...spec,
      id,
      url: config.target.url,
      origin: config.target.origin,
      token: mintToken(jwtSecret, config.fleet?.userIdBase ?? 9_000_000 + id),
    });
  });
  await Promise.all(
    workers.map((w, i) =>
      perWorker[i].length
        ? workerCall(w, { cmd: 'add', bots: perWorker[i], staggerMs: config.fleet?.staggerMs ?? 150 }, 'added')
        : Promise.resolve()
    )
  );
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function collectFleetStats() {
  const all = await Promise.all(workers.map((w) => workerCall(w, { cmd: 'stats' }, 'stats')));
  const agg = { botsConnected: 0, consumersActive: 0, audioFramesReceived: 0, errors: 0 };
  const joins = [];
  for (const { counters } of all) {
    agg.botsConnected += counters.botsConnected;
    agg.consumersActive += counters.consumersActive;
    agg.audioFramesReceived += counters.audioFramesReceived;
    agg.errors += counters.errors;
    joins.push(...counters.joinLatenciesMs);
  }
  joins.sort((a, b) => a - b);
  agg.joinLatencyMsP50 = percentile(joins, 50);
  agg.joinLatencyMsP95 = percentile(joins, 95);
  return agg;
}

async function main() {
  if (argv['dry-run']) {
    console.log('Dry run: guard passed, config valid. Ramp schedule:');
    console.table(config.ramp.steps);
    return;
  }

  // AC: do not run until epic 2's telemetry is queryable. Pre-flight V1–V3
  // against an idle-but-scraped environment proves the pipeline exists.
  spawnWorkers();
  const steps = [];
  const stepDefaults = { speakersPerRoom: config.ramp.speakersPerRoom ?? 2 };

  for (const [i, step] of config.ramp.steps.entries()) {
    const { rooms, listenersPerRoom, speakersPerRoom = stepDefaults.speakersPerRoom } = step;
    console.log(`\n▶ step ${i}: ${rooms} rooms × ${listenersPerRoom} listeners (+${speakersPerRoom} speakers)`);
    const startedAt = new Date().toISOString();
    await scaleTo(rooms, listenersPerRoom, speakersPerRoom);

    console.log(`  holding ${holdSeconds}s…`);
    // Signalling gates (G1/G2, Q14-Q16) use [5m] windows; the join phase is
    // over within the hold's first minute, so for long holds they must be
    // captured mid-hold or the window is empty and the step reads VOID
    // (SLO doc §7.5, evaluation-timing note). Short holds (<300s) keep the
    // single end-of-hold evaluation — the whole step fits in the window.
    let signalling = null;
    if (holdSeconds >= 300) {
      const midMs = 240 * 1000;
      await new Promise((r) => setTimeout(r, midMs));
      signalling = await evaluateSignalling(prom, { region });
      console.log(`  signalling gates @t=240s: ${signalling.gates.map((g) => `${g.id}=${g.status}`).join(' ')}`);
      await new Promise((r) => setTimeout(r, holdSeconds * 1000 - midMs));
    } else {
      await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    }

    const fleet = await collectFleetStats();
    const slo = await evaluateStep(prom, { expectedWorkers: config.target.expectedWorkers, region, signalling });
    const record = { stepIndex: i, rooms, listenersPerRoom, speakersPerRoom, startedAt, endedAt: new Date().toISOString(), fleet, slo };
    recorder.recordStep(record);
    steps.push(record);
    console.log(`  verdict: ${slo.verdict}${slo.firstFailingGate ? ` (first failing gate: ${slo.firstFailingGate})` : ''}`);

    if (slo.verdict === 'FAIL' && (config.ramp.stopOnFail ?? true)) {
      console.log('  first gate failure — ceiling found, stopping ramp.');
      break;
    }
    if (slo.verdict === 'VOID') {
      console.log('  ⚠️ VOID step — telemetry guard failed; fix the environment, this run certifies nothing.');
      break;
    }
  }

  recorder.writeSummary(steps);
  console.log(`\nRun recorded in ${runDir}`);
  await Promise.all(workers.map((w) => workerCall(w, { cmd: 'stop' }, 'stopped')));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
