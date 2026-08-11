# FlyLive headless real-media load harness (epic 3b · ticket 34)

Drives a fleet of **real-media** headless clients — real Opus encode (speakers push 48 kHz PCM
through libwebrtc) and real decode (listeners run an `RTCAudioSink` per consumed leg, so RTCP
receiver reports flow back to the SFU) — against a **dedicated load-test environment**, ramping
rooms × listeners on a schedule and recording epic 2's audio SLO queries next to throughput at
every step.

Source of truth for every gate and threshold:
[`docs/reference/audio-slo-and-load-test-queries.md`](../../../docs/reference/audio-slo-and-load-test-queries.md).
`src/queries.mjs` transcribes it; **never edit a threshold here without editing the doc.**

## Production is impossible by construction

`src/guard.mjs` refuses to start unless ALL of:

1. Target hostname is **not** `*.flyliveapp.com` / `*.flylive.app` / the prod box name (hard-coded
   deny-list, not configurable).
2. `config.target.environmentName === "load-test"` (explicit declaration).
3. `LOAD_HARNESS_ALLOW_TARGET=<exact hostname>` is exported for the run (positive handshake, no
   default, no wildcard).

Bot JWTs are minted locally from `LOAD_JWT_SECRET` — the load-test environment's own secret. The
production secret never enters this tool.

## Environment prerequisites (the run is VOID without them)

| Prerequisite | Why |
|---|---|
| MSAB instance(s) with epic 2 metrics live, scraped by a Prometheus the harness can query (`config.prometheus.url`) | The harness records V1–V4 / Q1–Q17 / G1–G2 / R1–R6 every step; guards empty ⇒ VOID |
| **`honor_labels = true`** in the scrape config | MSAB publishes its own `region`/`instance` on the six audio series; without it the scraper renames them `exported_*` and the queries read the wrong labels |
| **node_exporter on the MSAB box(es)**, scraped by the same Prometheus | `process_cpu_seconds_total` covers the Node main process only; mediasoup's C++ workers appear in NO exported series. Without host CPU the run reads an idle box while workers saturate |
| **Real loss/delay on the bot→SFU path** (different network, or `tc netem` on the bot host, e.g. `tc qdisc add dev eth0 root netem delay 40ms 10ms loss 0.5%`) | A clean same-LAN fleet reports RTT≈0 / loss≈0 → pre-flight **V4 fails → RTP verdict VOID, not passed** |
| `CORS_ORIGINS` on the target MSAB includes `config.target.origin` | The handshake rejects unknown Origins before auth |
| `LARAVEL_API_URL` on the target MSAB pointed at a **load-test backend or stub** (never prod) | Seat persistence and event push are HTTP side effects; a prod-pointed URL would create real side effects |
| `JWT_SECRET` on the target MSAB = `LOAD_JWT_SECRET` given to the harness | Bots mint their own tokens |
| Bot host sized for the fleet | libwebrtc runs native threads per peer; spread bots via `fleet.processes` and multiple bot hosts if needed |

## Usage

```bash
cd scripts/load-harness
npm install                      # socket.io-client, mediasoup-client, @roamhq/wrtc
cp config.example.json config.json   # edit target/prometheus/ramp
export LOAD_HARNESS_ALLOW_TARGET=10.20.1.50
export LOAD_JWT_SECRET=<load-test env JWT secret>
node run.mjs --config config.json          # or --dry-run to validate config + guard
```

Each ramp step: scale the fleet up → hold `holdSeconds` (≥600 — §7.0 rule 4: a level only counts
after 10 sustained minutes) → query all gates + readouts → record. The ramp stops at the first
FAIL (the knee: highest fully-passing step) or VOID (broken telemetry — fix the environment).

## Output — the run directory is the deliverable

`runs/<timestamp>/`:

- `run-meta.json` — config + invocation, so a second run (e.g. against a different instance size,
  ticket 35) is directly comparable.
- `steps.jsonl` — one line per step: fleet throughput (bots, consumers, decoded frames, join
  p50/p95, errors) **and** the full SLO evaluation, side by side.
- `SUMMARY.md` — human table, one row per step: load, R1 listener legs, verdict, first failing
  gate, join p95, event-loop lag, CPU — plus the computed knee.

## Harness self-checks (never loosen — fix the harness)

- **Q11** (`media_room_gate_rejections`) non-zero ⇒ a bot touched media before its `room:join`
  ack. Harness bug.
- **Q12** (`socket_event_budget_exceeded`) non-zero ⇒ the fleet flooded signaling (or the budget
  is genuinely too tight — human call). `staggerMs` exists for this.
- `audioFramesReceived` in the fleet stats is the harness's own proof that audio was actually
  decoded, not just signaled.

## What this tool does not do

- It does not choose an instance size or draw conclusions — that's ticket 35.
- It has no unit tests by design (spec Testing Decisions): the recorded run is the artifact.
- It is excluded from the server's lint/typecheck/test surface (standalone package under
  `scripts/`).
