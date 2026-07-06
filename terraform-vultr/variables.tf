# =============================================================================
# FlyLive Audio Server (Vultr) — Terraform Variables
# =============================================================================
# Skeleton variable surface. These shape the tfvars so staging and production
# differ ONLY by environment-specific values (state backend, fleet counts,
# domains, secrets). Resources that consume them land in slice D.
# =============================================================================

# The Vultr API key is NOT a Terraform variable — the provider reads it natively
# from VULTR_API_KEY in the environment (see providers.tf). Keeping it off the
# variable surface avoids a sensitive value in tfvars/state.

# --- Identity / environment --------------------------------------------------

variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
  default     = "flylive-audio"
}

variable "environment" {
  description = "Deployment environment — tag/label only. staging and production are isolated by SEPARATE Vultr accounts, not by this value."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be \"staging\" or \"production\"."
  }
}

# --- Region fleet ------------------------------------------------------------
# Vultr region codes (verified via api.vultr.com/v2/regions):
#   bom = Mumbai, fra = Frankfurt, sgp = Singapore.
# Map value = desired fixed-fleet instance count in that region (Phase 1 is a
# manually-scaled fixed HA fleet; keep >= 2 per region in prod for HA).
variable "fleet_regions" {
  description = "Vultr region code -> desired fixed-fleet instance count. The faithful 3-region staging replica mirrors prod's region set."
  type        = map(number)
  default = {
    bom = 2
    fra = 2
    sgp = 2
  }
}

variable "instance_plan" {
  description = "Vultr plan ID for MSAB instances (CPU-optimized / High Frequency recommended for mediasoup)."
  type        = string
  default     = "vhf-2c-4gb"
}

# --- Slice D: single-region tracer ------------------------------------------
# The tracer stands up exactly ONE region (multi-region fan-out is slice 06).

variable "tracer_region" {
  description = "The single Vultr region code this tracer deploys into. Must be a key of fleet_regions."
  type        = string
  default     = "bom"
}

variable "image_tag" {
  description = "Pinned ghcr.io image tag (sha-<commit8> from the CI run that built it). Never \"latest\"."
  type        = string
}

variable "ghcr_pull_token" {
  description = "Read-only classic GitHub PAT (read:packages only) instances use to `docker login ghcr.io`. See terraform-vultr/README.md § Image registry."
  type        = string
  sensitive   = true
}

variable "valkey_plan" {
  description = "Vultr managed-database plan ID for the region's shared HA Valkey endpoint."
  type        = string
  default     = "vultr-dbaas-business-rp-intel-1-12-2"
}

variable "valkey_version" {
  description = "Valkey engine version. Vultr's \"Deploy Database\" dashboard offers 8.1-9.0 and defaults to 9.0 (confirmed live 2026-07-06)."
  type        = string
  default     = "9.0"
}

variable "mediasoup_num_workers" {
  description = "MediaSoup workers = vCPU - 1 (reserve one core for the Node.js event loop). Default 1 matches instance_plan's default vhf-2c-4gb (2 vCPU) — adjust if instance_plan changes."
  type        = number
  default     = 1
}

# --- Broadcast HLS tier (realtime-09) -----------------------------------------
# Mirrors ../terraform/variables.tf exactly (same runtime, same feature). The
# config schema's refine() only requires the R2 fields when enabled, so a
# default-false instance boots fine untouched.

variable "broadcast_hls_enabled" {
  description = "Enable the LL-HLS broadcast publish tier (realtime-09)."
  type        = bool
  default     = false
}

variable "hls_r2_endpoint" {
  description = "R2 S3 API endpoint, e.g. https://<acct>.r2.cloudflarestorage.com"
  type        = string
  default     = ""
}

variable "hls_r2_bucket" {
  description = "R2 bucket for live HLS artifacts (e.g. flylive-live-hls)."
  type        = string
  default     = ""
}

variable "hls_public_base_url" {
  description = "Public CDN base for HLS playback (no trailing slash), e.g. https://live.flyliveapp.com"
  type        = string
  default     = ""
}

variable "hls_r2_access_key_id" {
  description = "R2 Object Read/Write access key id for HLS publishing."
  type        = string
  sensitive   = true
  default     = ""
}

variable "hls_r2_secret_access_key" {
  description = "R2 Object Read/Write secret access key for HLS publishing."
  type        = string
  sensitive   = true
  default     = ""
}

# --- Networking / media ports ------------------------------------------------

variable "app_port" {
  description = "Application HTTP/WebSocket port."
  type        = number
  default     = 3030
}

variable "rtc_min_port" {
  description = "Minimum WebRTC UDP port (media + cascade)."
  type        = number
  default     = 10000
}

variable "rtc_max_port" {
  description = "Maximum WebRTC UDP port (media + cascade)."
  type        = number
  default     = 59999
}

# --- Domains / origins -------------------------------------------------------

variable "audio_domain" {
  description = "Base domain for the audio server (per-region hosts derived from it, e.g. mumbai.<domain>)."
  type        = string
  default     = "audio.flyliveapp.com"
}

variable "cors_origins" {
  description = "Comma-separated browser ORIGINs the MSAB app accepts (the web frontend host)."
  type        = string
  default     = "https://flyliveapp.com,https://app.flyliveapp.com"
}

variable "laravel_api_url" {
  description = "Base URL MSAB instances use to reach the Laravel backend (internal calls)."
  type        = string
  default     = "https://app.flyliveapp.com"
}

# --- Secrets (must EQUAL the matching Laravel Cloud env vars per environment) --
# Rotated fresh at cutover (slice J) — never carry the old AWS plaintext values.

variable "laravel_internal_key" {
  description = "Shared secret for Laravel <-> MSAB internal API auth (X-Internal-Key). == Laravel MSAB_INTERNAL_KEY."
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT secret shared with Laravel. == Laravel MSAB_JWT_SECRET."
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Express session secret."
  type        = string
  sensitive   = true
  default     = ""
}

# NOTE: no redis_auth_token variable — unlike ElastiCache's auth_token input,
# Vultr managed databases generate and own the admin password themselves
# (vultr_database.password, a computed output the compute module consumes).

# --- Cloudflare Realtime TURN ------------------------------------------------

variable "cloudflare_turn_api_key" {
  description = "Cloudflare Realtime TURN API bearer token — server fetches short-lived credentials dynamically."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_turn_key_id" {
  description = "Cloudflare Realtime TURN key ID (short hex in the API URL)."
  type        = string
  default     = ""
}
