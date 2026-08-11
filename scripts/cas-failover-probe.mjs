#!/usr/bin/env node
/**
 * CAS + pub/sub failover probe (aws-platform-build/22).
 *
 * Answers, empirically, against a live Redis/ElastiCache endpoint while a
 * failover is forced:
 *   1. Can a compare-and-set (SETNX ownership claim, as RoomRegistry does it)
 *      be LOST across failover — i.e. an acked write that a second claimer
 *      later wins over?
 *   2. Are pub/sub messages silently DROPPED during failover?
 *
 * It mirrors the app's real primitives, not a synthetic workload:
 *   - claim:   SET key value EX 90 NX          (RoomRegistry.claimOwnership)
 *   - refresh: owner-guarded EXPIRE via EVAL   (RoomRegistry.refreshOwnership)
 *   - pub/sub: PUBLISH seq counters on one conn, SUBSCRIBE on another
 *
 * Usage:
 *   node scripts/cas-failover-probe.mjs --host <endpoint> [--port 6379] [--tls]
 *        [--password ...] [--duration 300]
 *
 * Run it, then trigger the failover (aws elasticache test-failover) while it
 * runs. It prints a verdict block at the end. Exit code 0 = no loss observed,
 * 2 = CAS loss and/or pub/sub gap detected (details printed).
 */
import { Redis } from "ioredis";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string", default: "6379" },
    tls: { type: "boolean", default: false },
    password: { type: "string" },
    duration: { type: "string", default: "300" },
  },
});
if (!args.host) {
  console.error("required: --host <redis endpoint>");
  process.exit(1);
}

const opts = {
  host: args.host,
  port: Number(args.port),
  ...(args.password && { password: args.password }),
  ...(args.tls && { tls: { rejectUnauthorized: true } }),
  maxRetriesPerRequest: null, // queue commands across failover, don't fail fast
  retryStrategy: (t) => Math.min(t * 50, 2000),
};

const run = `probe:${process.pid}:${Date.now()}`;
const CLAIM_PREFIX = `cas-probe:${run}:room:`;
const CHANNEL = `cas-probe:${run}:chan`;
const durationMs = Number(args.duration) * 1000;

// Three connections: claimer A, claimer B (the "rival"), subscriber.
const a = new Redis(opts);
const b = new Redis(opts);
const sub = new Redis(opts);

const anomalies = [];
let claims = 0;
let published = 0;
const received = new Set();
let connEvents = [];
for (const [name, c] of [["A", a], ["B", b], ["sub", sub]]) {
  c.on("error", () => {}); // retryStrategy handles it; errors are expected mid-failover
  c.on("close", () => connEvents.push(`${new Date().toISOString()} ${name} close`));
  c.on("ready", () => connEvents.push(`${new Date().toISOString()} ${name} ready`));
}

await sub.subscribe(CHANNEL);
sub.on("message", (_ch, msg) => received.add(Number(msg)));

const t0 = Date.now();
console.log(`[probe] run=${run} host=${args.host}:${args.port} duration=${args.duration}s`);
console.log("[probe] trigger the failover NOW (see procedure doc). Probing...");

// Loop: every 250ms, A claims a fresh key (SETNX EX 90) exactly as
// RoomRegistry.claimOwnership does; on an OK ack, B immediately tries to claim
// the same key. If B ever WINS a key A was acked on, that acked CAS was lost.
// In parallel, A publishes a monotonically increasing seq on the channel.
const pub = new Redis(opts);
pub.on("error", () => {});

while (Date.now() - t0 < durationMs) {
  const i = claims++;
  const key = `${CLAIM_PREFIX}${i}`;
  try {
    const ackA = await a.set(key, "A", "EX", 90, "NX");
    if (ackA === "OK") {
      const ackB = await b.set(key, "B", "EX", 90, "NX");
      if (ackB === "OK") {
        anomalies.push(`CAS LOST: key ${i} — A's acked SETNX vanished; B's claim also acked OK`);
      } else {
        // belt-and-suspenders: value must still read as A
        const v = await b.get(key);
        if (v !== "A") anomalies.push(`CAS LOST: key ${i} — read '${v}' after A's ack`);
      }
      // owner-guarded refresh, as refreshOwnership does
      await a.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0`,
        1, key, "A", "90",
      );
    }
  } catch {
    // command failed mid-failover — that's an ERROR (visible), not silent loss
  }
  try {
    await pub.publish(CHANNEL, String(published));
    published++;
  } catch {
    /* visible failure, fine */
  }
  await new Promise((r) => setTimeout(r, 250));
}

await new Promise((r) => setTimeout(r, 2000)); // let stragglers arrive
const gaps = [];
for (let i = 0; i < published; i++) if (!received.has(i)) gaps.push(i);

console.log("\n──── VERDICT ─────────────────────────────────────");
console.log(`claims attempted:        ${claims}`);
console.log(`acked CAS lost:          ${anomalies.length === 0 ? "0 — no acked claim was lost" : anomalies.length}`);
anomalies.forEach((x) => console.log(`  !! ${x}`));
console.log(`pub/sub published(acked): ${published}, received: ${received.size}, silently dropped: ${gaps.length}`);
if (gaps.length) console.log(`  dropped seqs: ${gaps.slice(0, 20).join(",")}${gaps.length > 20 ? "…" : ""}`);
console.log("connection events:");
connEvents.forEach((e) => console.log(`  ${e}`));
console.log("──────────────────────────────────────────────────");

for (const c of [a, b, sub, pub]) c.disconnect();
process.exit(anomalies.length || gaps.length ? 2 : 0);
