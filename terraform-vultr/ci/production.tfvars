# =============================================================================
# CI production var file — NON-SECRET values only (safe to commit).
# =============================================================================
# The deploy + infra workflows load this with -var-file and inject every SECRET
# via TF_VAR_* environment variables sourced from GitHub Actions secrets
# (jwt_secret, laravel_internal_key, session_secret, ghcr_pull_token,
# lb_ssl_certificate/private_key, cloudflare_turn_*, hls_r2_access_key_id/secret).
# `image_tag` is passed via `-var image_tag=<sha>` by the deploy (the freshly
# built tag), never pinned here.
#
# Keep this in lockstep with the non-secret half of the gitignored prod.tfvars —
# they must describe the SAME fleet. `terraform apply -replace` applies EVERY
# diff (not just the replaced instance), so any drift here would reprovision
# the fleet with the drifted config mid-deploy.
# =============================================================================

environment     = "production"
audio_domain    = "audio.flyliveapp.com"
cors_origins    = "https://flyliveapp.com,https://app.flyliveapp.com,https://localhost,capacitor://localhost"
laravel_api_url = "https://app.flyliveapp.com"

# bom-only fleet per 2026-07-08 right-sizing: Vultr's $100/mo cap counts ALL
# services (Valkey $30 + LB $10 + instances). 2× vhf-2c-4gb ($24 each) = $88
# is the only HA config that fits. Bump plan/regions when the limit lifts.
#
# 🔴 STALE SINCE 2026-07-31 — reality is ONE box, not two. `bom-01` was destroyed
# that day; only `flylive-audio-production-bom-02` survives. This file was not
# updated because Terraform cannot run against this fleet at all (Vultr removed
# the VPC 2.0 API — every `vultr_instance` read 404s), so editing it changes
# nothing and would only add risk:
#
# ⛔ DO NOT "correct" this to `bom = 1`. Terraform's `count` destroys from the
#    TAIL, so `bom = 1` targets main[1] = bom-02 — the box that is still alive.
#    It would destroy production and keep the box that no longer exists.
#
# Whoever gets Terraform working again (AWS cutover) must reconcile state with
# reality FIRST, before any plan/apply. See docs/reference/hard-won-gotchas.md
# § "Vultr fleet / Terraform deploy".
fleet_regions = {
  bom = 2
}
instance_plan = "vhf-2c-4gb"
region_instance_plans = {
  fra = "voc-g-4c-16gb-80s-amd" # Frankfurt has no High Frequency line
}
# Must be ≥2 (source→distribution router pipe needs separate workers) and
# ≤ vCPU-1 (leave a core for the Node event loop) → 2 on the 2-vCPU plan.
mediasoup_num_workers = 2

# Same 1 vCPU / 2 GB redundant specs as business-rp at half the price.
valkey_plan = "vultr-dbaas-startup-rp-intel-1-12-2"

tracer_region = "bom"

# SFU cascade (aws-app-affinity/12) — pinned explicitly to `true` to PRESERVE
# the currently-running value now that the flag is reachable from Terraform.
# It was previously coming from the compute module's own `true` default
# (unreachable from here); this line is the reachability fix, not a change —
# see 12-cascade-flag-reachable-and-asserted.md. Flipping this to `false` is
# ticket 13, and requires affinity_enabled = true (07/09/11) first or the
# instance refuses to boot.
cascade_enabled = true
# affinity_enabled stays at its `false` default: 07/09/11 have not shipped, so
# there is nothing yet to attest to. Do not flip until they have.

# Broadcast HLS tier (realtime-09) — R2 keys come from TF_VAR_* secrets.
broadcast_hls_enabled = true
hls_r2_endpoint       = "https://f7006f3d39297a83ca86eca240b906d4.r2.cloudflarestorage.com"
hls_r2_bucket         = "flylive-live-hls"
hls_public_base_url   = "https://live.flyliveapp.com"
