# =============================================================================
# CI staging var file — NON-SECRET values only (safe to commit).
# =============================================================================
# Template for the future staging Vultr account (does not exist yet — see the
# migration plan). Same secret-injection contract as ci/production.tfvars:
# secrets arrive via TF_VAR_* from GitHub Actions secrets, image_tag via -var.
# Fill in staging-specific R2 / domain values when the staging account is stood up.
# =============================================================================

environment     = "staging"
audio_domain    = "audio.staging.flyliveapp.com"
cors_origins    = "https://staging.flyliveapp.com,https://app.staging.flyliveapp.com"
laravel_api_url = "https://app.staging.flyliveapp.com"

fleet_regions = {
  bom = 2
  fra = 2
  sgp = 2
}
instance_plan = "vhf-4c-16gb"
region_instance_plans = {
  fra = "voc-g-4c-16gb-80s-amd" # Frankfurt has no High Frequency line
}
mediasoup_num_workers = 3
tracer_region         = "bom"

# Broadcast HLS tier — disabled by default on staging until R2 staging bucket exists.
broadcast_hls_enabled = false
