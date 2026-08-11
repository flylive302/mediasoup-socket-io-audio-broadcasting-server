#!/usr/bin/env node
/**
 * verify-alarms.mjs — prove the alarms are LOADED, not merely written down.
 *
 * Ticket 32, AC-2: "An automated check proves the rules are actually loaded
 * into the alerting engine, not just present as a file."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY A TERRAFORM TEST IS NOT ENOUGH
 * ─────────────────────────────────────────────────────────────────────────────
 * `terraform test` runs against a mocked provider, offline. It proves the
 * CONFIG declares an alarm. It cannot prove the alarm exists in CloudWatch,
 * that its actions are enabled, or that anything is subscribed to the topic it
 * fires into. Those are three separate ways to have alerting that looks fine
 * and reaches nobody:
 *
 *   1. alarm not applied            → nothing evaluates
 *   2. alarm applied, actions off   → it evaluates and stays silent
 *   3. actions on, no subscriber    → it publishes into an empty topic
 *
 * This project has already been burned by the third class of failure in a
 * different stack: an alert set that was believed to reach nobody, and a
 * separate alarm set that was deaf from creation because the alarm queried a
 * dimension the app never published. Both looked healthy from the config side.
 *
 * The check therefore compares LIVE AWS state against what Terraform DECLARES,
 * rather than against a hand-maintained list that can drift from either.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSERTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. Every alarm Terraform declares exists in CloudWatch.        (loaded)
 *   B. Each one has ActionsEnabled = true.                         (armed)
 *   C. Each one has at least one alarm_action.                     (wired)
 *   D. The alerts SNS topic has >= 1 CONFIRMED subscription.       (reaches a human)
 *
 * D is the one that matters most and is easiest to skip. An email subscription
 * sits at "PendingConfirmation" until somebody clicks the link in the mail;
 * until then the topic has a subscriber that receives nothing. That state is
 * indistinguishable from healthy unless you look for it, so we look for it.
 *
 * NOT asserted: alarm StateValue. A freshly applied alarm on a fleet with no
 * traffic is legitimately INSUFFICIENT_DATA, so failing on it would make the
 * check cry wolf on every green deploy. State is reported, never enforced.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/verify-alarms.mjs [--terraform-dir ./terraform] [--region ap-south-1]
 *   node scripts/verify-alarms.mjs --expected-file alarms.json --topic-arn arn:...
 *
 * Requires: AWS CLI v2 on PATH, credentials with cloudwatch:DescribeAlarms and
 * sns:ListSubscriptionsByTopic. Read-only — it never mutates anything.
 *
 * Exit codes: 0 = all assertions passed · 1 = at least one failed ·
 *             2 = could not run the check at all (missing CLI, bad creds, no
 *                 terraform outputs). 2 is deliberately distinct from 1: "the
 *                 check could not run" must never be misread as "alerting is
 *                 broken", nor as a pass.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));

/** CloudWatch caps DescribeAlarms --alarm-names at 100 per call. */
const DESCRIBE_ALARMS_BATCH = 100;

function parseArgs(argv) {
  const out = {
    terraformDir: "./terraform",
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null,
    expectedFile: null,
    topicArn: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--terraform-dir":
        out.terraformDir = value;
        i += 1;
        break;
      case "--region":
        out.region = value;
        i += 1;
        break;
      case "--expected-file":
        out.expectedFile = value;
        i += 1;
        break;
      case "--topic-arn":
        out.topicArn = value;
        i += 1;
        break;
      case "--help":
      case "-h":
        console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        fail(2, `Unknown argument: ${flag}`);
    }
  }
  return out;
}

function fail(code, message) {
  console.error(`\n✗ ${message}`);
  process.exit(code);
}

function run(cmd, cmdArgs, { cwd } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err.stderr ?? "").toString().trim();
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${stderr || err.message}`);
  }
}

function aws(serviceArgs) {
  const withRegion = args.region ? [...serviceArgs, "--region", args.region] : serviceArgs;
  return JSON.parse(run("aws", [...withRegion, "--output", "json"]));
}

/**
 * The expected set comes from Terraform itself, so the check cannot pass by
 * agreeing with a stale hand-written list. Two outputs are required:
 * `alarm_names` (list of strings) and `alerts_topic_arn` (string).
 */
function loadExpectations() {
  if (args.expectedFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(args.expectedFile, "utf8"));
    } catch (err) {
      fail(2, `Could not read ${args.expectedFile} as JSON: ${err.message}`);
    }
    const names = Array.isArray(parsed) ? parsed : parsed.alarm_names;
    if (!Array.isArray(names)) {
      fail(2, `${args.expectedFile} must be a JSON array of alarm names, or {"alarm_names": [...]}.`);
    }
    return { alarmNames: names, topicArn: args.topicArn ?? parsed.alerts_topic_arn ?? null };
  }

  let raw;
  try {
    raw = run("terraform", ["output", "-json"], { cwd: args.terraformDir });
  } catch (err) {
    fail(
      2,
      `Could not read terraform outputs from ${args.terraformDir}.\n` +
        `  ${err.message}\n` +
        `  This check compares live AWS against what Terraform declares, so it needs an\n` +
        `  initialised working dir with applied state — or pass --expected-file instead.`,
    );
  }

  const outputs = JSON.parse(raw);
  const alarmNames = outputs.alarm_names?.value;
  const topicArn = args.topicArn ?? outputs.alerts_topic_arn?.value ?? null;

  if (!Array.isArray(alarmNames) || alarmNames.length === 0) {
    fail(
      2,
      `Terraform output "alarm_names" is missing or empty.\n` +
        `  Without it this check has nothing to compare against and would trivially "pass".\n` +
        `  Expose every declared alarm name from the root module as output "alarm_names".`,
    );
  }
  return { alarmNames, topicArn };
}

function describeAlarms(names) {
  const found = new Map();
  for (let i = 0; i < names.length; i += DESCRIBE_ALARMS_BATCH) {
    const batch = names.slice(i, i + DESCRIBE_ALARMS_BATCH);
    const res = aws(["cloudwatch", "describe-alarms", "--alarm-names", ...batch]);
    for (const alarm of res.MetricAlarms ?? []) found.set(alarm.AlarmName, alarm);
    for (const alarm of res.CompositeAlarms ?? []) found.set(alarm.AlarmName, alarm);
  }
  return found;
}

function main() {
  const { alarmNames, topicArn } = loadExpectations();
  const failures = [];
  const rows = [];

  console.log(`Checking ${alarmNames.length} alarms declared by Terraform…\n`);

  let live;
  try {
    live = describeAlarms(alarmNames);
  } catch (err) {
    fail(2, `Could not query CloudWatch: ${err.message}`);
  }

  for (const name of alarmNames) {
    const alarm = live.get(name);

    if (!alarm) {
      failures.push(`${name}: DECLARED BUT NOT PRESENT in CloudWatch — the config was never applied.`);
      rows.push([name, "MISSING", "—", "—", "—"]);
      continue;
    }

    const actions = alarm.AlarmActions ?? [];
    const armed = alarm.ActionsEnabled === true;

    if (!armed) {
      failures.push(`${name}: exists but ActionsEnabled=false — it evaluates and pages nobody.`);
    }
    if (actions.length === 0) {
      failures.push(`${name}: exists but has zero alarm_actions — firing does nothing.`);
    }

    rows.push([
      name,
      "present",
      armed ? "armed" : "DISARMED",
      actions.length === 0 ? "NO ACTIONS" : `${actions.length} action(s)`,
      alarm.StateValue ?? "?",
    ]);
  }

  printTable(
    ["Alarm", "Exists", "Actions enabled", "Targets", "State (FYI)"],
    rows,
  );

  // D — does anything actually receive what these alarms publish?
  if (!topicArn) {
    failures.push(
      "No alerts topic ARN available, so the subscriber check could not run. " +
        'Expose output "alerts_topic_arn" or pass --topic-arn.',
    );
  } else {
    let subs;
    try {
      subs = aws(["sns", "list-subscriptions-by-topic", "--topic-arn", topicArn]).Subscriptions ?? [];
    } catch (err) {
      fail(2, `Could not list SNS subscriptions: ${err.message}`);
    }

    const confirmed = subs.filter((s) => s.SubscriptionArn !== "PendingConfirmation");
    const pending = subs.length - confirmed.length;

    console.log(`\nSNS topic ${topicArn}`);
    console.log(`  subscriptions: ${subs.length} total · ${confirmed.length} confirmed · ${pending} pending`);
    for (const s of subs) {
      const state = s.SubscriptionArn === "PendingConfirmation" ? "PENDING — never delivers" : "confirmed";
      console.log(`    ${s.Protocol.padEnd(8)} ${s.Endpoint}  [${state}]`);
    }

    if (confirmed.length === 0) {
      failures.push(
        subs.length === 0
          ? "The alerts topic has NO subscriptions — every alarm fires into an empty topic."
          : `The alerts topic has ${pending} subscription(s), all UNCONFIRMED. ` +
            "An email subscription delivers nothing until the recipient clicks the confirmation link.",
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`  · ${f}`);
    console.error("");
    process.exit(1);
  }

  console.log("\n✓ Every declared alarm exists, is armed, has a target, and the topic has a confirmed subscriber.");
  process.exit(0);
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

main();
