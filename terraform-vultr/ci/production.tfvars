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

# Broadcast HLS tier (realtime-09) — R2 keys come from TF_VAR_* secrets.
broadcast_hls_enabled = true
hls_r2_endpoint       = "https://f7006f3d39297a83ca86eca240b906d4.r2.cloudflarestorage.com"
hls_r2_bucket         = "flylive-live-hls"
hls_public_base_url   = "https://live.flyliveapp.com"
