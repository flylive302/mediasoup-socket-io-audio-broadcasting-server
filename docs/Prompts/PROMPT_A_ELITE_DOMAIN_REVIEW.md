# ELITE DOMAIN FORENSIC AUDIT — FlyLive Audio Server

## Context (Auto-Detected)

| Key               | Value                                        |
| ----------------- | -------------------------------------------- |
| Repo Root         | `$(pwd)`                                     |
| Branch            | `$(git rev-parse --abbrev-ref HEAD)`         |
| Commit            | `$(git rev-parse --short HEAD)`              |
| Node Version      | `$(node -v)` (requires ≥22.0.0)              |
| Package Manager   | npm (package-lock.json present)              |
| Runtime           | Node.js ESM (type: module)                   |
| HTTP Framework    | Fastify 5                                    |
| Realtime Stack    | Socket.io 4.8 + @socket.io/redis-adapter 8.3 |
| Media Stack       | Mediasoup 3.15                               |
| Redis Client      | ioredis 5.4                                  |
| Metrics           | prom-client 15.1                             |
| Logger            | pino 9.5                                     |
| Validation        | zod 3.24                                     |
| Auth Integration  | JWT (HMAC-SHA256, local verification)        |
| Test Framework    | Vitest 3.2                                   |
| Build Tool        | tsup 8.3 / tsx 4.19                          |
| CI Provider       | GitHub Actions (Node 24.x matrix)            |
| TypeScript Target | ES2024 / NodeNext                            |

---

## How to Run Me

1. Clone this prompt as your initial instruction
2. Execute bootstrap commands below
3. Scan `src/` to auto-discover domains
4. Perform evaluation per weighted dimensions
5. Output findings to `docs/audits/` and `reports/`
6. Commit to branch `chore/ai-audit-<timestamp>`

---

## Bootstrap Commands (Derived from package.json)

```bash
# Verify environment
node -v                    # Must be ≥22.0.0
git rev-parse --short HEAD # Capture commit for audit metadata

# Install dependencies
npm ci

# Quality gates
npm run lint               # eslint src
npm run typecheck          # tsc --noEmit
npm run test               # vitest run
npm run build              # tsup src/index.ts --format esm --dts

# Discovery commands
rg -n "TODO|FIXME|HACK|XXX" src/
rg -l "any" src/ --type ts  # Find type erosion
grep -r "console\." src/    # Find debug artifacts
```

---

## Domain Auto-Discovery

Scan `src/domains/` for subdirectories. Current layout:

| Domain | Location             | Handler                 |
| ------ | -------------------- | ----------------------- |
| chat   | `src/domains/chat/`  | `chat.handler.ts`       |
| gift   | `src/domains/gift/`  | `giftHandler.ts`        |
| media  | `src/domains/media/` | `media.handler.ts`      |
| room   | `src/domains/room/`  | `room.handler.ts`       |
| seat   | `src/domains/seat/`  | `seat.handler.ts` (+16) |
| user   | `src/domains/user/`  | `user.handler.ts`       |

Additional scopes:

| Layer          | Location                      |
| -------------- | ----------------------------- |
| Infrastructure | `src/infrastructure/`         |
| Socket Core    | `src/socket/`                 |
| Config         | `src/config/`                 |
| Auth           | `src/auth/`                   |
| Integrations   | `src/integrations/` (Laravel) |
| Utils          | `src/utils/`                  |
| Shared Types   | `src/shared/`                 |

---

## Evaluation Dimensions (Fixed Weights)

| Dimension                  | Weight |
| -------------------------- | ------ |
| Performance & Efficiency   | 30     |
| Architecture & Scalability | 20     |
| Realtime Correctness       | 15     |
| Code Quality               | 15     |
| Security & Reliability     | 10     |
| Readability                | 10     |

---

## Scope for Review

### Handlers & Transport

- All `*.handler.ts` files in `src/domains/*/`
- `src/socket/index.ts` — connection lifecycle
- `src/socket/schemas.ts` — Zod event schemas

### Workers & Media

- `src/infrastructure/worker.manager.ts` — Mediasoup worker pool
- `src/domains/media/routerManager.ts` — Router lifecycle
- `src/domains/media/activeSpeaker.ts` — Audio level detection
- `src/config/mediasoup.ts` — Worker codecs/settings

### Redis Layers

- `src/infrastructure/redis.ts` — Connection factory
- `src/domains/seat/seat.repository.ts` — Redis-backed seats
- `src/integrations/laravel/` — Pub/sub event routing

### Metrics & Observability

- `src/infrastructure/metrics.ts` — Prometheus collectors
- `src/infrastructure/health.ts` — Health endpoints

### Config & Validation

- `src/config/index.ts` — Zod schema validation

### Tests

- `src/socket/schemas.test.ts`
- `src/utils/rateLimiter.test.ts`

---

## Finding Format (8 lines max per issue)

```
Severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
File: <path>
Function: <name or class.method>
Problem: <one-line summary>
Evidence: `<code snippet>`
Impact: <runtime consequence>
Repro: <CLI command to demonstrate>
Fix: <exact remediation direction>
Complexity: <hours estimate>
Docs: <path to update>
```

---

## Over-Engineering Penalties

For each instance of unnecessary abstraction:

```
File: <path>
Anti-pattern: <description>
Runtime cost: <memory/CPU/latency penalty>
Dev-hours/year: <maintenance estimate>
Score deduction: <points>
```

---

## Output Artifacts

### Markdown Report

Path: `docs/audits/<YYYY-MM-DD-HHmm>.md`

Structure:

1. Executive Summary
2. Context Metadata (from above)
3. Bootstrap Results
4. Domain Coverage Matrix
5. Findings by Dimension (sorted by severity)
6. Over-Engineering Penalties
7. Aggregate Scores
8. Priority Remediation Queue

### JSON Report

Path: `reports/audit-<YYYY-MM-DD-HHmm>.json`

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
        "commit": { "type": "string" },
        "branch": { "type": "string" },
        "nodeVersion": { "type": "string" }
      }
    },
    "scores": {
      "type": "object",
      "properties": {
        "performance": { "type": "number" },
        "architecture": { "type": "number" },
        "realtime": { "type": "number" },
        "codeQuality": { "type": "number" },
        "security": { "type": "number" },
        "readability": { "type": "number" },
        "total": { "type": "number" }
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "severity": { "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] },
          "dimension": { "type": "string" },
          "file": { "type": "string" },
          "function": { "type": "string" },
          "problem": { "type": "string" },
          "evidence": { "type": "string" },
          "impact": { "type": "string" },
          "repro": { "type": "string" },
          "fix": { "type": "string" },
          "complexity": { "type": "string" },
          "docsPath": { "type": "string" }
        }
      }
    },
    "overEngineering": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string" },
          "antiPattern": { "type": "string" },
          "runtimeCost": { "type": "string" },
          "devHoursPerYear": { "type": "number" },
          "scoreDeduction": { "type": "number" }
        }
      }
    }
  }
}
```

---

## CLI Reproduction Commands

Include for each finding where applicable:

```bash
# Memory profiling
node --inspect dist/index.js
clinic doctor -- node dist/index.js

# Load testing
autocannon -c 100 -d 30 http://localhost:3030/health
k6 run scripts/load-test.js

# Static analysis
npx depcheck
npm audit --audit-level=high
```

---

## Commit

```bash
git checkout -b chore/ai-audit-$(date +%Y%m%d%H%M)
git add docs/audits/ reports/
git commit -m "chore(audit): domain forensic review $(date +%Y-%m-%d)"
```

DO NOT open a PR. Manual review required.
