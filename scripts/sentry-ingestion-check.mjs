#!/usr/bin/env node
/**
 * Sentry ingestion watchdog.
 *
 * Between 2026-08-04 and 2026-08-07 Sentry ingested NOTHING from any of the
 * three FlyLive projects, and nothing noticed for three days. Every alert we
 * own fires when an event ARRIVES; when nothing arrives, every one of them
 * stays quiet, and quiet is indistinguishable from a good day.
 *
 * 🔴 This check must NOT depend on Sentry being up. It is therefore a plain
 * scheduled job that reads the outcomes API from outside, and signals by
 * exiting non-zero — it never posts to Sentry, and it uses no Sentry alert
 * rule, because those depend on the exact thing that was broken.
 *
 * See docs/pending-issues/observability-audio-quality/19-alert-on-absence-of-telemetry.md
 *
 * Usage:
 *   SENTRY_ACCESS_TOKEN=… node scripts/sentry-ingestion-check.mjs
 *   … --window 6                 hours of silence tolerated before alerting
 *   … --replay 2026-08-05        evaluate a fixed past day instead of "now"
 *                                (proves the check fires; see --replay below)
 *
 * Exit codes:
 *   0  healthy
 *   1  🔴 blackout — errors are not being accepted
 *   2  the check itself could not run (network, auth, bad response)
 */

const ORG = process.env.SENTRY_ORG || 'flylive'
const API = 'https://sentry.io/api/0'

// The real blackout ran 72 hours. Error volume also legitimately drops
// overnight — measured trough is ~14 errors/hour against ~95 at peak — so a
// single empty hour means nothing. 6 hours is longer than any observed quiet
// period and still 12x faster than the three days this actually took.
const DEFAULT_WINDOW_HOURS = 6

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function fail(code, ...lines) {
  for (const l of lines) console.error(l)
  process.exit(code)
}

const token = process.env.SENTRY_ACCESS_TOKEN
if (!token) {
  fail(2, '::error::SENTRY_ACCESS_TOKEN is not set. The check cannot run.')
}

const windowHours = Number(arg('window', DEFAULT_WINDOW_HOURS))
if (!Number.isFinite(windowHours) || windowHours < 1) {
  fail(2, `::error::--window must be a positive number of hours, got "${arg('window')}"`)
}

// `--replay <YYYY-MM-DD>` scores a fixed past day instead of the last N hours.
// This is how the alarm is PROVEN to fire without waiting for an outage:
// 2026-08-05 and 2026-08-06 are real, dated, fully blacked-out days.
const replay = arg('replay', null)

/** @returns {Promise<{intervals: string[], byOutcome: Record<string, number[]>}>} */
async function readOutcomes() {
  const params = new URLSearchParams({
    field: 'sum(quantity)',
    groupBy: 'outcome',
    category: 'error',
    interval: '1h',
  })

  if (replay) {
    // Sentry's start/end are inclusive-ish; one full UTC day is enough to score.
    params.set('start', `${replay}T00:00:00`)
    params.set('end', `${replay}T23:59:59`)
  } else {
    // Ask for one extra hour: the newest bucket is always partial and
    // under-reports, so it is read but never allowed to trigger on its own.
    params.set('statsPeriod', `${windowHours + 1}h`)
  }

  const url = `${API}/organizations/${ORG}/stats_v2/?${params}`

  let res
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  } catch (e) {
    fail(2, `::error::Could not reach the Sentry outcomes API: ${e.message}`)
  }

  if (!res.ok) {
    // 401/403 here means the token lost `org:read` — a silent failure of the
    // watchdog itself, which is why it exits 2 rather than 0.
    fail(2, `::error::Sentry outcomes API returned HTTP ${res.status}. The watchdog is blind.`)
  }

  const body = await res.json()
  const byOutcome = {}
  for (const g of body.groups ?? []) byOutcome[g.by.outcome] = g.series['sum(quantity)']
  return { intervals: body.intervals ?? [], byOutcome }
}

const { intervals, byOutcome } = await readOutcomes()

if (!intervals.length) {
  fail(2, '::error::Sentry returned no intervals. Cannot judge ingestion state.')
}

const at = (name, i) => (byOutcome[name] ? byOutcome[name][i] ?? 0 : 0)

// Drop the newest bucket unless replaying: it is partial by construction and
// would otherwise manufacture a "zero accepted" hour on every single run.
// A replay scores the whole requested day; a live run scores the window.
const scored = replay
  ? intervals
  : intervals.slice(0, intervals.length - 1).slice(-Math.ceil(windowHours))

let accepted = 0
let rateLimited = 0
for (let i = 0; i < intervals.length; i++) {
  if (!scored.includes(intervals[i])) continue
  accepted += at('accepted', i)
  rateLimited += at('rate_limited', i)
}

const label = replay ? `replay of ${replay}` : `last ${scored.length}h`
const summary = `accepted=${accepted} rate_limited=${rateLimited} over the ${label}`

if (accepted > 0) {
  console.log(`✅ Sentry is ingesting — ${summary}`)
  if (rateLimited > 0) {
    // Not fatal, but it is the LEADING indicator: in the 2026-08-07 incident
    // rate-limiting began a week before acceptance hit zero.
    console.log(
      `::warning::Some events are being rate-limited (${rateLimited}). `
      + 'Quota pressure precedes a blackout — check the reserves at '
      + `${API}/customers/${ORG}/`,
    )
  }
  process.exit(0)
}

// accepted === 0. The two causes need different fixes, and telling them apart
// is most of the diagnosis — so the alert says which one it is.
const cause = rateLimited > 0
  ? [
    '🔴 QUOTA / BUDGET EXHAUSTED — Sentry is RECEIVING events and discarding them.',
    `   ${rateLimited} events were rate-limited while 0 were accepted.`,
    `   ➡️  Check reserves and on-demand budget: GET ${API}/customers/${ORG}/`,
    '      (categories[].reserved vs .usage, onDemandMaxSpend, onDemandSpendUsed)',
  ]
  : [
    '🔴 NOTHING IS ARRIVING — Sentry received no events at all, not even to discard.',
    '   ➡️  Suspect the apps, the DSN, or the network — not the quota.',
    '   ⚠️  A genuinely quiet period looks like this too. Confirm real traffic first.',
  ]

fail(
  1,
  `::error::Sentry has accepted ZERO errors for ${scored.length} hours.`,
  ...cause,
  '',
  `   ${summary}`,
  '   ⛔ Do not "fix" this by muting a Sentry issue.',
  '   📄 docs/issues/observability-audio-quality/18-sentry-ingestion-blackout.md',
)
