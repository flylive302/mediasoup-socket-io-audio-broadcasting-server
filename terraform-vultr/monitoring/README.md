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

## Where Alloy runs (production)

Since 2026-07-14 the agent runs on a dedicated always-on ops box — **NOT** on a
laptop (a WSL host sleeps and its clock skews, which stamps samples into the
past and blanks every now-anchored dashboard):

- Instance: `flylive-ops-monitoring`, Vultr bom, `vc2-1c-1gb` ($5/mo),
  `65.20.70.100`, id `543fe2b8-dcb3-4a7d-b8ab-3e82dfeb7c92`.
- Created API-direct (deliberately outside the Terraform stack, same
  decoupling rationale as central-Alloy itself). Cloud-init installs Docker and
  brings up this directory's compose file at `/opt/msab-monitoring/` with the
  Alloy UI bound to localhost only.
- SSH: `ssh -i ~/.ssh/flylive_deploy root@65.20.70.100`.
- Target-list changes: edit `config.alloy` here, then
  `scp config.alloy root@65.20.70.100:/opt/msab-monitoring/ && ssh … 'cd /opt/msab-monitoring && docker compose restart'`.
- The old laptop container is stopped with `--restart=no`; never run two Alloy
  writers at once (duplicate series → out-of-order rejections).

## Live verification (historical — fleet now live)

The bom fleet is live; fra/sgp scrape blocks in `config.alloy` stay commented
until those regions return.
