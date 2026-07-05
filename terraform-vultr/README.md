# FlyLive Audio — Vultr Terraform

The new MSAB substrate (PRD [`docs/prd-msab-vultr-migration.md`](../../docs/prd-msab-vultr-migration.md)).
The AWS stack in [`../terraform/`](../terraform/) is **kept as a dormant, redeployable backup** — do not delete it.

> **Slice A status: SKELETON ONLY.** Provider + remote-state backend + variables + tfvars layout.
> There are **no resources yet** — `terraform plan` returns *"No changes"*. Networking / compute /
> managed Valkey / load-balancer modules arrive in **slice D** (`04-single-region-vultr-tracer.md`).

## Layout

| File | Role |
|---|---|
| `versions.tf` | Terraform + `vultr/vultr` provider pin; S3-compatible **Vultr Object Storage** state backend (no locking yet — see note). |
| `providers.tf` | `provider "vultr"` — API key from `VULTR_API_KEY`. Region is a per-resource arg, **not** a provider alias. |
| `variables.tf` | Variable surface shared by both environments. |
| `outputs.tf` | Empty until slice D. |
| `staging.tfvars.example` / `prod.tfvars.example` | Per-env values. Copy to `*.tfvars` (gitignored) and fill in secrets. |
| `backend-staging.hcl.example` / `backend-prod.hcl.example` | Per-account state-bucket config. Copy to `backend.hcl` (gitignored). |

Two environments = **two separate Vultr accounts** (blast-radius wall). They differ only by
`backend.hcl`, `*.tfvars`, and the `VULTR_API_KEY` you export — the Terraform code is identical, so
staging faithfully predicts production.

## Init an environment

```bash
# 1. account credential (that environment's Personal Access Token)
export VULTR_API_KEY=<account PAT>

# 2. state backend (Object Storage S3 keys from that account's subscription)
cp backend-staging.hcl.example backend.hcl     # edit bucket + endpoints.s3
export AWS_ACCESS_KEY_ID=<object-storage access key>
export AWS_SECRET_ACCESS_KEY=<object-storage secret key>
terraform init -reconfigure -backend-config=backend.hcl

# 3. plan (expect "No changes" until slice D)
cp staging.tfvars.example staging.tfvars        # fill in secrets
terraform plan -var-file=staging.tfvars
```

## Notes

- **State locking is not enabled.** Terraform's native S3 lock (`use_lockfile`) needs conditional-write
  (`If-None-Match`) support, which Vultr Object Storage (Ceph RGW) may lack. With a zero-resource skeleton
  and a single operator this is fine; confirming/enabling locking is a **slice-08** (CI, multi-actor) gate.
  Fallback if unsupported: Terraform Cloud free tier (native locking, $0).
- **Vultr is a global API.** Multi-region fleets come from the `fleet_regions` map (`bom`/`fra`/`sgp` =
  Mumbai/Frankfurt/Singapore), not per-region provider aliases like AWS.
- Manual dashboard steps (accounts, API key, deploy-limit, Object Storage bucket) are in
  [`docs/issues/vultr-migration/A-vultr-dashboard-walkthrough.md`](../../docs/issues/vultr-migration/A-vultr-dashboard-walkthrough.md).
