# ELITE REMEDIATION PLAN — FlyLive Audio Server

## Context (Auto-Detected)

| Key             | Value                                        |
| --------------- | -------------------------------------------- |
| Repo Root       | `$(pwd)`                                     |
| Branch          | `$(git rev-parse --abbrev-ref HEAD)`         |
| Commit          | `$(git rev-parse --short HEAD)`              |
| Node Version    | `$(node -v)` (requires ≥22.0.0)              |
| Package Manager | npm (package-lock.json present)              |
| Runtime         | Node.js ESM (type: module)                   |
| HTTP Framework  | Fastify 5                                    |
| Realtime Stack  | Socket.io 4.8 + @socket.io/redis-adapter 8.3 |
| Media Stack     | Mediasoup 3.15                               |
| Redis Client    | ioredis 5.4                                  |
| Metrics         | prom-client 15.1                             |
| Test Framework  | Vitest 3.2                                   |
| Build Tool      | tsup 8.3                                     |
| CI Provider     | GitHub Actions                               |

---

## How to Run Me

1. Ensure audit JSON exists at `reports/audit-<timestamp>.json`
2. Parse findings array from audit
3. Generate remediation plan for EVERY finding
4. Create atomic PR patch sketches
5. Output to `docs/remediation/` and `reports/`
6. Generate diffs in `PATCHES/` folder
7. Commit to branch `chore/ai-remediate-<timestamp>`

---

## Input Requirements

Consumes: `reports/audit-<YYYY-MM-DD-HHmm>.json`

---

## Per-Issue Remediation Format

For EVERY issue in audit JSON:

```
Issue ID: <from audit>
Severity: <inherited>
Files Touched:
  - <path1>
  - <path2>

Patch Sketch:
\`\`\`diff
- <old code>
+ <new code>
\`\`\`

Downstream Callsites:
  - <file>:<line> — <function>
  - <file>:<line> — <function>

Runtime Risk: <what could break>
Rollback: <exact revert command or strategy>
Hours: <estimate>
Owner: <team/individual>
Priority: P0 | P1 | P2 | P3
Docs Updates:
  - <doc path> — <section to update>

Tests Required:
  - <test file> — <describe test case>
```

---

## Mediasoup Worker Tuning

Review and optimize `src/infrastructure/worker.manager.ts`:

| Setting                 | Current     | Target (Millions Scale) |
| ----------------------- | ----------- | ----------------------- |
| Worker count            | `os.cpus()` | Fixed based on load     |
| Router limit per worker | 100         | Benchmark to tune       |
| CPU update interval     | 10s         | Consider 30s for scale  |
| Worker restart backoff  | 1s/2s/4s    | Verify for production   |

Tuning commands:

```bash
# Profile worker CPU
node --cpu-prof dist/index.js

# Monitor worker PIDs
ps aux | grep mediasoup-worker
```

---

## Socket.io Scaling Strategy

Current: Redis adapter with pub/sub

For millions of concurrent users:

| Component           | Recommendation                     |
| ------------------- | ---------------------------------- |
| Adapter             | @socket.io/redis-adapter (current) |
| Redis topology      | Redis Cluster or Sentinel          |
| Sticky sessions     | Required with multiple instances   |
| Connection pooling  | Configure maxRetriesPerRequest     |
| Namespace isolation | Per-domain if needed               |

Verify in `src/infrastructure/server.ts`:

```typescript
// Current adapter setup — ensure cluster-ready
adapter: createAdapter(pubClient, subClient);
```

---

## Redis Topology

Current: Single instance (configurable via env)

For scale:

| Tier        | Topology           |
| ----------- | ------------------ |
| Development | Single node        |
| Staging     | Sentinel (3 nodes) |
| Production  | Cluster (6+ nodes) |

Config validation in `src/config/index.ts` already supports:

- REDIS_HOST
- REDIS_PORT
- REDIS_PASSWORD
- REDIS_TLS
- REDIS_DB

Add for cluster:

- REDIS_CLUSTER_NODES (comma-separated)
- REDIS_SENTINEL_NODES

---

## Metrics & Alerts

Current collectors in `src/infrastructure/metrics.ts`:

Verify and add:

| Metric                       | Type      | Labels     |
| ---------------------------- | --------- | ---------- |
| socket_connections_total     | Counter   | namespace  |
| rooms_active                 | Gauge     | —          |
| mediasoup_workers_active     | Gauge     | —          |
| mediasoup_routers_active     | Gauge     | worker_pid |
| transport_created_total      | Counter   | type       |
| producer_created_total       | Counter   | kind       |
| consumer_created_total       | Counter   | kind       |
| gift_buffer_size             | Gauge     | —          |
| event_processing_duration_ms | Histogram | event_type |

Alert thresholds:

```yaml
- alert: HighWorkerCPU
  expr: mediasoup_worker_cpu_usage > 80
  for: 5m

- alert: RoomCountHigh
  expr: rooms_active > 10000
  for: 1m

- alert: GiftBufferBacklog
  expr: gift_buffer_size > 1000
  for: 30s
```

---

## Dependency Removal Matrix

Review `package.json` for removal candidates:

| Package     | Used? | Replacement/Action            |
| ----------- | ----- | ----------------------------- |
| dotenv      | Yes   | Keep (Zod parses process.env) |
| pino-pretty | Dev   | Move to devDependencies only  |

Run:

```bash
npx depcheck
npm audit --audit-level=high
```

---

## Static Analysis Commands

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Dead code detection
npx ts-prune

# Dependency audit
npm audit --audit-level=high
npx depcheck

# Find unused exports
npx knip
```

---

## Load Test Commands

```bash
# Autocannon (HTTP endpoints)
autocannon -c 1000 -d 60 http://localhost:3030/health
autocannon -c 1000 -d 60 http://localhost:3030/metrics

# k6 (WebSocket load)
k6 run --vus 1000 --duration 5m scripts/ws-load-test.js

# Clinic.js (profiling)
clinic doctor -- node dist/index.js
clinic flame -- node dist/index.js
clinic bubbleprof -- node dist/index.js

# Memory profiling
node --expose-gc --inspect dist/index.js
```

---

## PATCHES Folder Structure

```
PATCHES/
├── 001-<issue-id>-<short-desc>.patch
├── 002-<issue-id>-<short-desc>.patch
└── ...
```

Generate with:

```bash
git diff HEAD~1 > PATCHES/001-fix-name.patch
```

---

## Atomic PR Patch Plan

For each finding, group into atomic PRs:

| PR # | Title                          | Files | Depends On |
| ---- | ------------------------------ | ----- | ---------- |
| 1    | fix(media): worker leak        | 2     | —          |
| 2    | perf(socket): reduce allocs    | 3     | —          |
| 3    | refactor(room): simplify state | 5     | PR #2      |

Each PR must:

- Pass `npm run typecheck`
- Pass `npm run lint`
- Pass `npm run test`
- Pass `npm run build`
- Include test updates

---

## Sprint Plan

| Sprint | Focus Area     | PRs   | Hours |
| ------ | -------------- | ----- | ----- |
| 1      | Critical fixes | 1-3   | 20    |
| 2      | Performance    | 4-7   | 30    |
| 3      | Architecture   | 8-10  | 25    |
| 4      | Tests & Docs   | 11-15 | 20    |

---

## Test Requirements

Existing tests (preserve initially, may delete/rewrite):

- `src/socket/schemas.test.ts`
- `src/utils/rateLimiter.test.ts`

New tests required (real-world load scenarios):

| Test File                                   | Coverage Target             |
| ------------------------------------------- | --------------------------- |
| `src/domains/room/room.handler.test.ts`     | Room lifecycle              |
| `src/domains/media/media.handler.test.ts`   | Transport/producer/consumer |
| `src/domains/seat/seat.repository.test.ts`  | Redis seat operations       |
| `src/infrastructure/worker.manager.test.ts` | Worker pool lifecycle       |
| `tests/load/socket-stress.test.ts`          | 10k concurrent connections  |

---

## Output Artifacts

### Markdown Report

Path: `docs/remediation/<YYYY-MM-DD-HHmm>.md`

Structure:

1. Executive Summary
2. Audit Reference
3. Per-Issue Remediation Details
4. PR Patch Plan
5. Sprint Plan
6. Infrastructure Recommendations
7. Test Plan
8. Rollback Procedures

### JSON Report

Path: `reports/remediation-<YYYY-MM-DD-HHmm>.json`

Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "meta": {
      "type": "object",
      "properties": {
        "timestamp": { "type": "string", "format": "date-time" },
        "auditRef": { "type": "string" },
        "commit": { "type": "string" }
      }
    },
    "remediations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "issueId": { "type": "string" },
          "severity": { "type": "string" },
          "filesTouched": { "type": "array", "items": { "type": "string" } },
          "patchSketch": { "type": "string" },
          "downstreamCallsites": {
            "type": "array",
            "items": { "type": "string" }
          },
          "runtimeRisk": { "type": "string" },
          "rollback": { "type": "string" },
          "hours": { "type": "number" },
          "owner": { "type": "string" },
          "priority": { "enum": ["P0", "P1", "P2", "P3"] },
          "docsUpdates": { "type": "array", "items": { "type": "string" } },
          "testsRequired": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "prPlan": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "prNumber": { "type": "integer" },
          "title": { "type": "string" },
          "files": { "type": "array", "items": { "type": "string" } },
          "dependsOn": { "type": "array", "items": { "type": "integer" } }
        }
      }
    },
    "sprintPlan": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sprint": { "type": "integer" },
          "focus": { "type": "string" },
          "prs": { "type": "array", "items": { "type": "integer" } },
          "hours": { "type": "number" }
        }
      }
    }
  }
}
```

---

## Commit

```bash
git checkout -b chore/ai-remediate-$(date +%Y%m%d%H%M)
mkdir -p PATCHES docs/remediation reports
git add PATCHES/ docs/remediation/ reports/
git commit -m "chore(remediate): comprehensive fix plan $(date +%Y-%m-%d)"
```

DO NOT open a PR. Manual review required.

---

## Guiding Principles

1. **Aggressively delete complexity** — remove abstractions with no runtime benefit
2. **Prefer native Node.js APIs** — avoid polyfills for features in Node 22+
3. **Battle-tested libs only** — ioredis, pino, zod are approved; minimize others
4. **Optimize for realtime audio** — latency trumps everything except correctness
5. **Millions of users** — every allocation matters, benchmark before/after
6. **Destructive changes allowed** — if it improves perf and passes tests, ship it
