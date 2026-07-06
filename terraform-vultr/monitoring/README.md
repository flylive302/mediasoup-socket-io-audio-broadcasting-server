# MSAB Monitoring — Grafana Cloud (slice 07)

Rebuilds the CloudWatch observability on Grafana Cloud (free tier). One central
**Grafana Alloy** agent scrapes every region's `/metrics/prometheus` over the
public reserved IPs and `remote_write`s to Grafana Cloud; two alert rules
recreate the outage + fanout-failure alarms.

## Why central Alloy (not a per-instance sidecar)

Grafana Cloud's hosted Prometheus **pulls nothing** — you push to it. A per-node
agent would have to live in `cloud-init`, and any change to `user_data`
force-replaces the whole Vultr fleet. A single central Alloy keeps monitoring
100% decoupled from the deploy path. Trade-off: it's a single scrape point —
`MSABRegionScrapeAbsent` covers the "Alloy itself died" case; for HA later, run
two Alloy replicas (dedup is handled by Grafana Cloud).

Targets in `config.alloy` are the **stable reserved IPs** — they survive an
instance replace. Re-sync them only when the fleet size changes:
`cd terraform-vultr && terraform output region_public_ips`.

## Files

| File | What |
|---|---|
| `config.alloy` | Scrape (3 regions, key-gated) + remote_write to Grafana Cloud. |
| `docker-compose.yml` | Runs the central Alloy agent. |
| `.env.example` | The 4 secrets (copy → `.env`, gitignored). |
| `alert-rules.yml` | The 2 alarms (+ scrape-absent safety net), Mimir rule format. |
| `dashboard.json` | Per-region overview (connections, CPU, up, fanout, rooms/workers). |

## Operator setup (one-time)

1. **Grafana Cloud account** (free) → create a stack. Under **Connections →
   Prometheus → "Sending metrics with `remote_write`"**, copy the push URL and
   instance ID, and create a **Cloud Access Policy token** scoped to
   `metrics:write`.
2. On any host with egress (a $5 Vultr box / ops host):
   ```bash
   cp .env.example .env    # fill LARAVEL_INTERNAL_KEY (= prod.tfvars laravel_internal_key)
                           # + GRAFANA_CLOUD_URL / _USER / _TOKEN from step 1
   docker compose up -d
   docker compose logs -f alloy    # confirm scrapes return 200 (not 401 → key mismatch)
   ```
3. **Dashboard** (AC1): Grafana → Dashboards → New → Import → paste
   `dashboard.json`, select the Prometheus datasource. Per-region
   `ActiveConnections`, CPU, and fanout are now live.
4. **Alerts** (AC2/AC3): load `alert-rules.yml` into the Grafana Cloud ruler —
   ```bash
   mimirtool rules load alert-rules.yml \
     --address="https://<stack>.grafana.net" --id="<instance-id>" --key="<token>"
   ```
   (or recreate each expr as a Grafana-managed alert rule).
5. **Notification** (AC4): Grafana → Alerting → **Contact points** → add an
   email (or Slack/Telegram) contact point; set the default **notification
   policy** to route `service=msab` there. Use **Test** to confirm you actually
   receive it.

## Acceptance criteria → mechanism

- **AC1** metrics scraped & visible per region → `config.alloy` scrape +
  `dashboard.json` (grouped by the `region` target label).
- **AC2** zero-healthy-targets alarm → `MSABRegionZeroHealthyTargets`
  (`max by (region)(up) == 0`), with `MSABRegionScrapeAbsent` guarding the
  scraper-down blind spot.
- **AC3** event-fanout-failure alarm → `MSABEventFanoutFailureRate` (failed
  `flylive_laravel_events_received_total` share > 5% for 5m).
- **AC4** operator receives it → contact point + notification policy (step 5).

## Live verification (blocked on Vultr account verification)

Steps 2–5 need the fleet reachable. The bom fleet is already live
(`65.20.69.175`, `65.20.90.188`); fra/sgp targets go green once slice 06's apply
finishes. Tracked in `docs/issues/vultr-migration/PENDING-vultr-verification.md`.
