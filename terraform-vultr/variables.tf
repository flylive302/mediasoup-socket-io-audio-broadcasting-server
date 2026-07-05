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
  description = "Vultr plan ID for MSAB instances (CPU-optimized / High Frequency recommended for mediasoup). Set per env once slice D lands."
  type        = string
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

variable "redis_auth_token" {
  description = "AUTH token for the managed Valkey endpoint (per region, shared by that region's fleet for cascade CAS ownership)."
  type        = string
  sensitive   = true
  default     = ""
}

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
