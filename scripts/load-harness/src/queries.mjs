/**
 * SLO gate catalog for the audio load harness, encoded verbatim from
 * docs/reference/audio-slo-and-load-test-queries.md (§7).
 *
 * 🔴 That document is the source of truth for every query string and every
 * threshold. Never change a query, a threshold, an `absent` policy or a
 * guard relationship here without first editing the doc — this file must
 * always be a faithful transcription of it, not an independent judgment
 * call. If the two ever disagree, the doc wins and this file is wrong.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function numOf(series) {
  const raw = series?.value?.[1];
  if (raw === undefined) return NaN;
  return Number(raw);
}

function labelValues(results, label) {
  return new Set(results.map((r) => r.metric?.[label]).filter((v) => v !== undefined));
}

function allValuesSatisfy(results, predicate) {
  if (results.length === 0) return false;
  return results.every((r) => predicate(numOf(r)));
}

// The query catalog below is transcribed from the doc verbatim, including its
// literal region="bom" — the doc's §10 says outright: "Substitute region="bom"
// for whatever the load-test environment uses." That substitution happens HERE,
// at execution time, so the catalog stays a faithful copy of the doc rather
// than drifting into an independent judgment call.
//
// 🔴 Why this matters on AWS: MSAB labels the six audio series with
// config.AWS_REGION (src/domains/media/quality/qualityPublisher.ts:36), which
// defaults to "ap-south-1" — NOT "bom", which is Vultr-era naming. With
// honor_labels: true the scraper keeps MSAB's own value, so an unsubstituted
// region="bom" matches zero series, V2/V3 come back empty, and the step is
// VOID before a single threshold is read.
const REGION_TOKEN = 'region="bom"';

export function withRegion(query, region) {
  if (!region) throw new Error("withRegion: a region label value is required");
  return query.split(REGION_TOKEN).join(`region="${region}"`);
}

// ---------------------------------------------------------------------------
// §7.1 pre-flight validity gates (V1-V4)
// ---------------------------------------------------------------------------

export const PRE_FLIGHT = [
  {
    id: "V1",
    query: 'up{region="bom"}',
    pass(results) {
      if (results.length === 0) return false;
      return results.every((r) => numOf(r) === 1);
    },
    failureMeans: "one or more targets under test are not up",
  },
  {
    id: "V2",
    query: 'sum by (instance, direction) (flylive_audio_quality_samples{region="bom"})',
    pass(results) {
      if (!allValuesSatisfy(results, (v) => v > 0)) return false;
      const directions = labelValues(results, "direction");
      return directions.has("sending") && directions.has("receiving");
    },
    failureMeans: "no live audio quality samples on one or both directions — Q1-Q3 unusable",
  },
  {
    id: "V3",
    query: 'sum by (instance, metric) (flylive_audio_rtp_samples{region="bom"})',
    pass(results) {
      if (!allValuesSatisfy(results, (v) => v > 0)) return false;
      const metrics = labelValues(results, "metric");
      return metrics.has("fraction_lost") && metrics.has("jitter") && metrics.has("round_trip_time");
    },
    failureMeans: "RTP sample collection incomplete — Q4-Q6 unusable",
  },
  {
    id: "V4",
    query:
      'max by (instance) (flylive_audio_rtp_round_trip_time_ms{region="bom", statistic="p90"})',
    pass(results) {
      return allValuesSatisfy(results, (v) => v > 0);
    },
    failureMeans:
      "RTCP not returning (synthetic peers never sent a receiver report) — Q4-Q6 are VOID, not passed; Q1-Q3 still stand",
  },
];

// ---------------------------------------------------------------------------
// §7.5 guards (G1, G2)
// ---------------------------------------------------------------------------

const G1_EVENTS = ["room:join", "transport:create", "transport:connect", "audio:produce", "audio:consume"];

export const GUARDS = [
  {
    id: "G1",
    query:
      'sum by (instance, event) (rate(flylive_socket_event_latency_seconds_count{region="bom", event=~"room:join|transport:create|transport:connect|audio:produce|audio:consume"}[5m]))',
    pass(results) {
      if (!allValuesSatisfy(results, (v) => v > 0)) return false;
      const events = labelValues(results, "event");
      return G1_EVENTS.every((e) => events.has(e));
    },
  },
  {
    id: "G2",
    query: 'sum by (instance) (rate(flylive_socket_events_total{region="bom"}[5m]))',
    pass(results) {
      return allValuesSatisfy(results, (v) => v > 0);
    },
  },
];

// ---------------------------------------------------------------------------
// §7.2 / §7.3 / §7.4 / §7.5 gates (Q1-Q17 — Q11/Q12 are harness-self-checks)
// ---------------------------------------------------------------------------

export const GATES = [
  {
    id: "Q1",
    kind: "server",
    guard: ["V2"],
    query:
      'min by (instance) (flylive_audio_quality_score{region="bom", direction="receiving", statistic="p10"})',
    threshold: 6,
    direction: "higher",
    absent: "fail",
    note: "listener quality floor (S1)",
  },
  {
    id: "Q2",
    kind: "server",
    guard: ["V2"],
    query:
      'min by (instance) (flylive_audio_quality_score{region="bom", direction="receiving", statistic="p01"})',
    threshold: 4,
    direction: "higher",
    absent: "fail",
    note: "listener worst-case (S2)",
  },
  {
    id: "Q3",
    kind: "server",
    guard: ["V2"],
    query:
      'min by (instance) (flylive_audio_quality_score{region="bom", direction="sending", statistic="p10"})',
    threshold: 6,
    direction: "higher",
    absent: "fail",
    note: "publisher quality floor (S3)",
  },
  {
    id: "Q4",
    kind: "server",
    guard: ["V3", "V4"],
    query:
      'max by (instance, direction) (flylive_audio_rtp_fraction_lost{region="bom", statistic="p90"})',
    threshold: 5.1,
    direction: "lower",
    absent: "fail",
    note: "packet loss, both directions (S4); VOID if V4 failed",
  },
  {
    id: "Q5",
    kind: "server",
    guard: ["V3", "V4"],
    query:
      'max by (instance) (flylive_audio_rtp_jitter{region="bom", direction="sending", statistic="p90"})',
    threshold: 1440,
    direction: "lower",
    absent: "fail",
    note: "uplink jitter (S5); VOID if V4 failed",
  },
  {
    id: "Q6",
    kind: "server",
    guard: ["V4"],
    query:
      'max by (instance, direction) (flylive_audio_rtp_round_trip_time_ms{region="bom", statistic="p90"})',
    threshold: 250,
    direction: "lower",
    absent: "fail",
    note: "round-trip time (S6); VOID if V4 failed",
  },
  {
    id: "Q7",
    kind: "server",
    guard: [],
    query:
      'sum by (instance) (increase(flylive_dist_pipe_setup_total{region="bom", result="failure"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "dist pipe setup failures (S7)",
  },
  {
    id: "Q8",
    kind: "server",
    guard: [],
    query:
      'sum by (instance) (increase(flylive_edge_pipe_setup_total{region="bom", result="failure"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "edge pipe setup failures (S7)",
  },
  {
    id: "Q9",
    kind: "server",
    guard: [],
    query:
      'sum by (instance) (increase(flylive_reverse_pipe_setup_total{region="bom", result="failure"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "reverse pipe setup failures (S7)",
  },
  {
    id: "Q10",
    kind: "server",
    guard: [],
    query: 'sum by (instance) (increase(flylive_redis_degradation_total{region="bom"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "Redis degradations (S8)",
  },
  {
    id: "Q11",
    kind: "harness-self-check",
    guard: [],
    query:
      'sum by (instance) (increase(flylive_media_room_gate_rejections_total{region="bom"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "non-zero = bot produced before room:join ack (harness bug, never loosen)",
  },
  {
    id: "Q12",
    kind: "harness-self-check",
    guard: [],
    query:
      'sum by (instance) (increase(flylive_socket_event_budget_exceeded_total{region="bom"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "non-zero = harness flooding, or budget too tight — human look either way",
  },
  {
    id: "Q13",
    kind: "server",
    guard: [],
    query: 'min by (instance) (flylive_mediasoup_workers_active{region="bom"})',
    threshold: null, // filled at evaluation time from expectedWorkers
    direction: "equal",
    absent: "fail",
    note: "workers alive (S9) — a dead worker invalidates capacity numbers",
  },
  {
    id: "Q14",
    kind: "server",
    guard: ["G1"],
    query:
      'histogram_quantile(0.95, sum by (le, instance) (rate(flylive_socket_event_latency_seconds_bucket{region="bom", event="room:join"}[5m])))',
    threshold: 1.0,
    direction: "lower",
    absent: "fail",
    note: 'join p95; a value of exactly 2.5 (top bucket) means "≥2.5s, unquantifiable" — treated as fail',
  },
  {
    id: "Q15",
    kind: "server",
    guard: ["G1"],
    query:
      'histogram_quantile(0.95, sum by (le, instance) (rate(flylive_socket_event_latency_seconds_bucket{region="bom", event=~"transport:create|transport:connect|audio:produce|audio:consume"}[5m])))',
    threshold: 0.5,
    direction: "lower",
    absent: "fail",
    note: 'media event p95; same 2.5s top-bucket rule as Q14',
  },
  {
    id: "Q16",
    kind: "server",
    guard: ["G2"],
    query:
      'sum by (instance) (rate(flylive_socket_events_total{region="bom", status="error"}[5m])) / sum by (instance) (rate(flylive_socket_events_total{region="bom"}[5m]))',
    threshold: 0.001,
    direction: "lower",
    absent: "void",
    note: "error ratio; NaN/empty is VOID, not pass",
  },
  {
    id: "Q17",
    kind: "server",
    guard: [],
    query:
      'sum by (instance) (increase(flylive_socket_registration_failures_total{region="bom"}[15m]))',
    threshold: 0,
    direction: "lower",
    absent: "pass",
    note: "socket registration failures (S10)",
  },
];

// ---------------------------------------------------------------------------
// §7.6 capacity readouts (not pass/fail)
// ---------------------------------------------------------------------------

export const READOUTS = [
  {
    id: "R1",
    query: 'sum by (instance, direction) (flylive_audio_quality_samples{region="bom"})',
    measures: "live client legs — the true concurrency axis; receiving = listener count",
  },
  {
    id: "R2",
    query: 'flylive_socket_connections_total{region="bom"}',
    measures: "connected sockets (gauge despite _total — never rate())",
  },
  {
    id: "R3",
    query: 'flylive_rooms_active{region="bom"}',
    measures: "active rooms",
  },
  {
    id: "R4",
    query: 'nodejs_eventloop_lag_p99_seconds{region="bom"}',
    measures: "Node main-thread saturation",
  },
  {
    id: "R5",
    query: 'rate(process_cpu_seconds_total{region="bom"}[5m])',
    measures: "cores used by the Node main process ONLY, not mediasoup workers",
  },
  {
    id: "R6",
    query: 'flylive_mediasoup_routers_per_worker{region="bom"}',
    measures: "router spread across workers",
  },
  {
    id: "node_cpu",
    query: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
    measures:
      "host CPU % — requires node_exporter; prerequisite, run is unusable without host CPU",
  },
  {
    id: "node_mem",
    query: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    measures:
      "host memory % — requires node_exporter; prerequisite, run is unusable without host CPU",
  },
];

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

function seriesValues(results) {
  return results.map((r) => ({ metric: r.metric, value: numOf(r) }));
}

function compareThreshold(value, threshold, direction) {
  if (direction === "higher") return value >= threshold;
  if (direction === "lower") return value <= threshold;
  if (direction === "equal") return value === threshold;
  throw new Error(`unknown direction "${direction}"`);
}

async function runGuard(promClient, guardDef, region) {
  const results = await promClient.instant(withRegion(guardDef.query, region));
  return { id: guardDef.id, pass: guardDef.pass(results), values: seriesValues(results) };
}

async function runGate(promClient, gateDef, { guardStatus, expectedWorkers, region }) {
  const guardFailed = (gateDef.guard ?? []).some((gid) => guardStatus[gid] === false);

  const results = await promClient.instant(withRegion(gateDef.query, region));
  const values = seriesValues(results);

  if (guardFailed) {
    return { id: gateDef.id, kind: gateDef.kind, status: "void", values, note: gateDef.note };
  }

  if (results.length === 0) {
    const status = gateDef.absent; // "fail" | "pass" | "void"
    return { id: gateDef.id, kind: gateDef.kind, status, values, note: gateDef.note };
  }

  // Q16: NaN (0/0) anywhere -> VOID.
  if (gateDef.id === "Q16" && values.some((v) => Number.isNaN(v.value))) {
    return { id: gateDef.id, kind: gateDef.kind, status: "void", values, note: gateDef.note };
  }

  // Q14/Q15: exact 2.5s reading = top-bucket, unquantifiable -> fail.
  if ((gateDef.id === "Q14" || gateDef.id === "Q15") && values.some((v) => v.value === 2.5)) {
    return {
      id: gateDef.id,
      kind: gateDef.kind,
      status: "fail",
      values,
      note: `${gateDef.note} — reading is exactly 2.5s (top bucket, unquantifiable)`,
    };
  }

  const threshold = gateDef.id === "Q13" ? expectedWorkers : gateDef.threshold;
  if (gateDef.id === "Q13" && (expectedWorkers === undefined || expectedWorkers === null)) {
    throw new Error("evaluateStep: Q13 requires options.expectedWorkers");
  }

  const allPass = values.every((v) => compareThreshold(v.value, threshold, gateDef.direction));
  return {
    id: gateDef.id,
    kind: gateDef.kind,
    status: allPass ? "pass" : "fail",
    values,
    note: gateDef.note,
  };
}

/**
 * Runs pre-flight, guards, gates and readouts once, and returns the full
 * verdict for one load-test step. Evaluation rules are transcribed from
 * docs/reference/audio-slo-and-load-test-queries.md §7.0/§7.7 — do not
 * change them here without changing the doc first.
 */
export async function evaluateStep(promClient, { expectedWorkers, region } = {}) {
  if (!region) {
    throw new Error(
      "evaluateStep: options.region is required — it is the value of the `region` label MSAB " +
        'publishes on the six audio series (config.AWS_REGION, e.g. "ap-south-1"). Set ' +
        "config.target.region. Guessing it wrong makes every gate VOID, not fail."
    );
  }
  const at = new Date().toISOString();

  const preFlight = [];
  for (const pf of PRE_FLIGHT) {
    const results = await promClient.instant(withRegion(pf.query, region));
    preFlight.push({ id: pf.id, pass: pf.pass(results), values: seriesValues(results) });
  }
  const preFlightPass = Object.fromEntries(preFlight.map((p) => [p.id, p.pass]));

  const guards = [];
  for (const g of GUARDS) {
    guards.push(await runGuard(promClient, g, region));
  }
  const guardStatus = Object.fromEntries(guards.map((g) => [g.id, g.pass]));

  // V1-V3 failing, or any guard failing, voids the whole step. V4 failing
  // does not void the step by itself — it only voids Q4-Q6 (handled per-gate
  // via each gate's own `guard` list, which includes "V4" where relevant).
  const coreVoid =
    !preFlightPass.V1 || !preFlightPass.V2 || !preFlightPass.V3 || guards.some((g) => !g.pass);

  const combinedGuardStatus = { ...preFlightPass, ...guardStatus };

  const gates = [];
  for (const gateDef of GATES) {
    gates.push(
      await runGate(promClient, gateDef, { guardStatus: combinedGuardStatus, expectedWorkers, region })
    );
  }

  const readouts = [];
  for (const r of READOUTS) {
    const results = await promClient.instant(withRegion(r.query, region));
    readouts.push({ id: r.id, values: seriesValues(results) });
  }

  let verdict;
  let firstFailingGate = null;
  if (coreVoid) {
    verdict = "VOID";
  } else {
    const failing = gates.find((g) => g.status === "fail");
    firstFailingGate = failing ? failing.id : null;
    verdict = failing ? "FAIL" : "PASS";
  }

  const gatesWithHarnessFlag = gates.map((g) => ({
    ...g,
    ...(g.kind === "harness-self-check" && g.status === "fail" ? { harnessBug: true } : {}),
  }));

  return { at, preFlight, verdict, gates: gatesWithHarnessFlag, guards, readouts, firstFailingGate };
}
