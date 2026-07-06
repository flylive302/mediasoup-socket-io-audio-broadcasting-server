# FlyLive Audio — Vultr Terraform

The new MSAB substrate (PRD [`docs/prd-msab-vultr-migration.md`](../../docs/prd-msab-vultr-migration.md)).
The AWS stack in [`../terraform/`](../terraform/) is **kept as a dormant, redeployable backup** — do not delete it.

> **Slice E status: single-region multi-instance fleet.** `main.tf` wires four
> modules — `networking` (firewall), `valkey` (HA managed database), `compute`
> (a fixed HA fleet of `fleet_regions[tracer_region]` instances, each with its
> own reserved/announced IP + a unique CAS `INSTANCE_ID_OVERRIDE` + cloud-init),
> `loadbalancer` (TLS 443, round-robins across the whole fleet) — for ONE region
> (`var.tracer_region`, default `bom`). The 3-region staging replica (slice 06)
> extends this by looping the same modules over `fleet_regions` with `for_each`,
> not by restructuring it. See `docs/issues/vultr-migration/{04-single-region-vultr-tracer,05-multi-instance-cascade}.md`.

## Layout

| File | Role |
|---|---|
| `versions.tf` | Terraform + `vultr/vultr` provider pin; **HCP Terraform (Terraform Cloud)** remote state backend (free tier, native locking). |
| `providers.tf` | `provider "vultr"` — API key from `VULTR_API_KEY`. Region is a per-resource arg, **not** a provider alias. |
| `variables.tf` | Variable surface shared by both environments. |
| `main.tf` | Wires `modules/{networking,valkey,compute,loadbalancer}` for the tracer region; `compute.instance_count = fleet_regions[tracer_region]`. |
| `outputs.tf` | `tracer_public_ips` (list — one per fleet instance), `tracer_lb_ipv4`, `tracer_lb_hostname`, `tracer_valkey_host`. |
| `modules/networking` | `vultr_firewall_group` + rules (app TCP, WebRTC/cascade UDP+TCP range). No SSH rule — use Vultr's web console. |
| `modules/valkey` | `vultr_database` (`engine=valkey`, business-tier 2-node HA plan). Vultr generates the admin password/CA itself — there's no `auth_token` input like AWS ElastiCache. |
| `modules/compute` | `count = instance_count` fleet: one `vultr_reserved_ip` (Terraform-known announced IP) + `vultr_instance` (`reserved_ip_id`) per instance, each with a unique index-derived `INSTANCE_ID_OVERRIDE`; cloud-init template; fleet-wide public-IP `check`. |
| `modules/loadbalancer` | `vultr_load_balancer`, TLS via bring-your-own cert (Cloudflare Origin CA — not `auto_ssl_domain`), `/health` check, TLS 443 → app port. |
| `tests/public_ip_contract.tftest.hcl` | Offline `terraform test` (mocked provider, no cost/credentials) proving the **fleet-wide** announced-IP contract on a 2-instance fleet: accepts an all-public fleet, rejects one where ANY instance's IP is private/loopback/empty. |
| `staging.tfvars.example` / `prod.tfvars.example` | Per-env values. Copy to `*.tfvars` (gitignored) and fill in secrets. |

Two environments = **two separate Vultr accounts** (blast-radius wall), mapped to two HCP workspaces
(`msab-vultr-staging` / `msab-vultr-production`). They differ only by `TF_WORKSPACE`, `*.tfvars`, and the
`VULTR_API_KEY` you export — the Terraform code is identical, so staging faithfully predicts production.

## State backend — HCP Terraform (Terraform Cloud), free tier

Chosen over Vultr Object Storage: $0 (vs $18/mo for the cheapest usable Object Storage tier), native state
locking, and CI-ready for slice H. HCP stores **state only** — plan/apply run locally with your local secrets
(set the workspace Execution Mode to **Local**).

One-time setup: sign up at `app.terraform.io`, note your **organization name**, and set the org's
**Default Execution Mode → Local** (Org Settings → General). Workspaces are auto-created on first `init`.

## Init an environment

```bash
# 1. auth to HCP Terraform (one-time; stores a user token in ~/.terraform.d/)
terraform login

# 2. Vultr account credential (that environment's Personal Access Token)
export VULTR_API_KEY=<account PAT>

# 3. select the HCP org + per-env workspace (keeps them out of committed code)
export TF_CLOUD_ORGANIZATION=<your HCP org>
export TF_WORKSPACE=msab-vultr-staging          # or msab-vultr-production
terraform init                                   # creates the workspace if absent

# 4. plan (creates: firewall group + rules, HA Valkey, N reserved IPs + N instances, load balancer)
cp staging.tfvars.example staging.tfvars         # fill in secrets, image_tag, ghcr_pull_token
terraform plan -var-file=staging.tfvars

# 5. offline contract test (mocked provider — no cost, no credentials needed)
terraform test
```

TLS on the load balancer is a **bring-your-own certificate (Cloudflare Origin CA)**, not
Vultr's `auto_ssl_domain` — that requires the domain to be a Vultr-hosted DNS zone in this
account (confirmed live: it fails apply with `"Domain not found for account: <domain>"`
otherwise), which would conflict with keeping Cloudflare as DNS authority. Generate one in
the Cloudflare dashboard (**Websites → the zone → SSL/TLS → Origin Server → Create
Certificate**) for `tracer_lb_hostname` (or a wildcard) and set `lb_ssl_certificate` /
`lb_ssl_private_key` in `*.tfvars`. After `apply`, point that hostname's Cloudflare DNS
record at `tracer_lb_ipv4`, **proxied (orange-cloud)** — Origin CA certs are only trusted by
Cloudflare's edge, not public browsers directly. Raw WebRTC media/cascade bypass this
hostname entirely (they use the instance's reserved IP directly), so proxying only the
signaling/WSS hostname is safe.

## Image registry — ghcr.io

The MSAB image is built and pushed by `.github/workflows/ghcr-publish.yml` on every push to
`master` (or manual dispatch) — the same build artifact as the old AWS/ECR pipeline, just a
different substrate. No new GitHub secret is needed to **push**: Actions authenticates to its
own registry with the built-in `GITHUB_TOKEN`.

- **Image:** `ghcr.io/flylive302/mediasoup-socket-io-audio-broadcasting-server`
- **Tags:** `sha-<commit8>` (deterministic, use this for cloud-init pins) and `latest`.
- Multi-arch manifest: `linux/amd64` + `linux/arm64`.

### Pulling from a Vultr instance (read-only token)

Instances have no AWS/GitHub Actions identity, so they need a **read-only pull token**. Use a
**classic personal access token** scoped to only `read:packages` — not a fine-grained token:
`flylive302` is an org, and org-owned container packages need the org's fine-grained-PAT policy
to explicitly allow/approve each token, an extra approval step a classic `read:packages` PAT
skips entirely (and it's the path GitHub's own container-registry docs point to for machine
pulls). Create it once as the operator:

1. GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic) →
   Generate new token**.
2. Scopes: check **only** `read:packages`. Nothing else.
3. If the `flylive302` org restricts classic PAT access to its resources, approve this token
   under **org Settings → Third-party access** (or **Personal access tokens** policy) once issued.
4. Copy the token — this is the value that goes into `ghcr_pull_token` in `*.tfvars` (sensitive,
   gitignored), the same way other secrets (JWT, internal key, Valkey auth) already flow
   `tfvars → cloud-init → instance env file`.

Cloud-init (`modules/compute/templates/cloud-init.sh.tpl`) logs in and pulls with:

```bash
echo "${ghcr_pull_token}" | docker login ghcr.io -u flylive302 --password-stdin
docker pull ghcr.io/flylive302/mediasoup-socket-io-audio-broadcasting-server:sha-<commit8>
```

Pin the SHA tag per deploy (from the CI run that built it) — never `latest` — so a cold-restore
or an instance replacement always launches the exact image that was staged/verified.

## Valkey TLS

Vultr managed databases present a **private CA** (not in the OS trust store), unlike ElastiCache's
AWS-trusted chain. Cloud-init writes the `ca_certificate` output to `/opt/msab/valkey-ca.pem` on the
instance and mounts it into the container; the app trusts it via `REDIS_TLS_CA_PATH` (see
`src/infrastructure/redis.ts`) so `rejectUnauthorized: true` still validates the connection instead of
disabling certificate verification.

## Notes

- **Vultr is a global API.** Multi-region fleets come from the `fleet_regions` map (`bom`/`fra`/`sgp` =
  Mumbai/Frankfurt/Singapore), not per-region provider aliases like AWS.
- **Tag-based workspaces must exist before a non-interactive `init`.** With `workspaces { tags = [...] }`,
  an interactive `terraform init` prompts to create a missing workspace, but `-input=false` / CI runs fail
  with *"Invalid workspace selection"*. Pre-create each workspace (name = `msab-vultr-<env>`, tag =
  `msab-vultr`, Execution Mode = Local) — via the HCP UI, or the API:
  `POST /organizations/<org>/workspaces` then `POST /workspaces/<id>/relationships/tags`.
  `msab-vultr-staging` already exists; create `msab-vultr-production` in the prod HCP context before slice J.
- Provider lockfile `.terraform.lock.hcl` is currently gitignored (mirrors the AWS dir). Reconsider
  committing it at slice H so CI pins provider versions reproducibly.
- Manual setup steps (accounts, API key, deploy-limit, HCP Terraform org) are in
  [`docs/issues/vultr-migration/A-vultr-dashboard-walkthrough.md`](../../docs/issues/vultr-migration/A-vultr-dashboard-walkthrough.md).
- **Plan IDs + Valkey version confirmed against the live Vultr dashboard/API (2026-07-06):**
  `instance_plan = "vhf-2c-4gb"` ($24/mo, 2 vCPU/4GB, available in `bom`), `valkey_plan =
  "vultr-dbaas-business-rp-intel-1-12-2"` (cheapest 2-node/HA Valkey-capable plan, $60/mo — the
  dashboard's own "Deploy Database" summary confirms this exact plan ID and cost), and
  `valkey_version = "9.0"` (dashboard offers 8.1-9.0, defaults to 9.0).
- Real `terraform plan` (against `msab-vultr-staging`, dummy secrets, no apply) and `terraform test`
  (mocked provider) both pass as of this slice — see the tracer issue for the full verification note.
