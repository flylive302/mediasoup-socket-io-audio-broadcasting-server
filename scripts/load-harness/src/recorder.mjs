/**
 * Run recorder for the audio load harness — writes machine-readable
 * (steps.jsonl) and human-readable (SUMMARY.md) output side by side in one
 * run directory, so two runs are directly diffable.
 *
 * Gate/verdict semantics come from queries.mjs, which transcribes
 * docs/reference/audio-slo-and-load-test-queries.md. This file only records
 * and renders that output — it must never invent its own pass/fail logic.
 */
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

function findReadout(step, id, direction) {
  const r = step.slo?.readouts?.find((x) => x.id === id);
  if (!r) return undefined;
  const series = direction ? r.values.find((v) => v.metric?.direction === direction) : r.values[0];
  return series?.value;
}

function fmt(n, digits = 1) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

export class RunRecorder {
  constructor(outDir, runMeta) {
    if (!outDir) throw new Error("RunRecorder requires outDir");
    this.outDir = outDir;
    this.stepsPath = path.join(outDir, "steps.jsonl");
    this.summaryPath = path.join(outDir, "SUMMARY.md");
    this.runMeta = { ...runMeta, startedAt: runMeta?.startedAt ?? new Date().toISOString() };
    this._ready = this._init();
  }

  async _init() {
    await mkdir(this.outDir, { recursive: true });
    await writeFile(path.join(this.outDir, "run-meta.json"), JSON.stringify(this.runMeta, null, 2));
  }

  /**
   * Appends one JSON line for a completed ramp step.
   * step: { stepIndex, rooms, listenersPerRoom, speakersPerRoom, startedAt,
   *         endedAt, fleet: { botsConnected, joinLatencyMsP50, joinLatencyMsP95,
   *         consumersActive, audioFramesReceived, errors }, slo }
   * `slo` is the object returned by queries.mjs's evaluateStep().
   */
  async recordStep(step) {
    await this._ready;
    const line = JSON.stringify(step);
    await appendFile(this.stepsPath, line + "\n");
  }

  /**
   * Writes SUMMARY.md: one row per ramp step (throughput and audio quality
   * side by side, per the doc's acceptance criterion) plus the knee
   * statement.
   */
  async writeSummary(steps) {
    await this._ready;

    const header =
      "| Step | Rooms | Listeners/room | R1 receiving | Verdict | First failing gate | Join p95 (ms) | Eventloop lag p99 (R4) | CPU rate (R5) | Host CPU % |\n" +
      "|---|---|---|---|---|---|---|---|---|---|";

    const rows = steps.map((s) => {
      const receiving = findReadout(s, "R1", "receiving");
      const r4 = findReadout(s, "R4");
      const r5 = findReadout(s, "R5");
      const hostCpu = findReadout(s, "node_cpu");
      return [
        `| ${s.stepIndex}`,
        s.rooms,
        s.listenersPerRoom,
        fmt(receiving, 0),
        s.slo?.verdict ?? "—",
        s.slo?.firstFailingGate ?? "—",
        fmt(s.fleet?.joinLatencyMsP95, 0),
        fmt(r4, 3),
        fmt(r5, 2),
        `${fmt(hostCpu, 1)} |`,
      ].join(" | ");
    });

    const knee = computeKnee(steps);
    const kneeLines = knee
      ? [
          "",
          "## Knee",
          "",
          `Highest sustained R1 (receiving) with verdict PASS held ≥10min: **${knee.receiving} listeners** (step ${knee.stepIndex}, rooms=${knee.rooms}).`,
          knee.nextFailingGate
            ? `First gate to fail at the step above the knee: **${knee.nextFailingGate}** (step ${knee.nextStepIndex}).`
            : "No step above the knee was recorded in this run.",
        ]
      : [
          "",
          "## Knee",
          "",
          "No step in this run sustained a PASS verdict for ≥10 minutes — the knee is undefined.",
        ];

    const md = [
      `# Load test run summary`,
      "",
      `Run started: ${this.runMeta.startedAt}`,
      this.runMeta.gitSha ? `Git SHA: ${this.runMeta.gitSha}` : null,
      this.runMeta.target ? `Target: ${this.runMeta.target}` : null,
      "",
      header,
      ...rows.map((r) => r), // eslint-disable-line
      ...kneeLines,
      "",
    ]
      .filter((l) => l !== null)
      .join("\n");

    await writeFile(this.summaryPath, md);
  }
}

const SUSTAINED_MS = 10 * 60 * 1000;

/**
 * Knee = highest R1(receiving) among steps whose verdict is PASS and whose
 * duration (endedAt - startedAt) was >= 10 minutes. Also reports the first
 * failing gate at the step immediately above the knee, if present.
 */
function computeKnee(steps) {
  const sustainedPasses = steps.filter((s) => {
    if (s.slo?.verdict !== "PASS") return false;
    const start = Date.parse(s.startedAt);
    const end = Date.parse(s.endedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return end - start >= SUSTAINED_MS;
  });

  if (sustainedPasses.length === 0) return null;

  const best = sustainedPasses.reduce((acc, s) => {
    const r1 = Number(findReadout(s, "R1", "receiving") ?? 0);
    const accR1 = Number(findReadout(acc, "R1", "receiving") ?? 0);
    return r1 > accR1 ? s : acc;
  });

  const sortedByIndex = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const bestPos = sortedByIndex.findIndex((s) => s.stepIndex === best.stepIndex);
  const above = sortedByIndex[bestPos + 1];

  return {
    stepIndex: best.stepIndex,
    rooms: best.rooms,
    receiving: fmt(findReadout(best, "R1", "receiving"), 0),
    nextStepIndex: above?.stepIndex,
    nextFailingGate: above?.slo?.firstFailingGate ?? null,
  };
}
