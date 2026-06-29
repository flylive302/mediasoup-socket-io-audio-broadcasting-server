# =============================================================================
# FlyLive Audio Server — Terraform Variables
# =============================================================================

variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
  default     = "flylive-audio"
}

variable "environment" {
  description = "Deployment environment — used for the Environment tag only (cost allocation). Resource names are isolated by AWS account, not this value."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be \"staging\" or \"production\"."
  }
}

variable "cors_origins" {
  description = "Comma-separated CORS origins the MSAB app accepts (the web frontend). Staging overrides with https://app.staging.flyliveapp.com."
  type        = string
  default     = "https://flyliveapp.com,https://app.flyliveapp.com"
}

variable "laravel_api_url" {
  description = "Base URL the MSAB instances use to reach the Laravel backend. Staging overrides with the staging app origin."
  type        = string
  default     = "https://app.flyliveapp.com"
}

variable "min_instances" {
  description = "ASG minimum instances per region. Default 2 for production HA (AUDIT-004). Staging may set 1 (or 0) between test cycles to cut cost without destroying the stack."
  type        = number
  default     = 2
}

variable "desired_instances" {
  description = "ASG desired instances per region. Default 2 for production HA. Staging may lower between test cycles; keep >= min_instances."
  type        = number
  default     = 2
}

variable "max_instances" {
  description = <<-EOT
    ASG maximum instances per region. Default 50 for the 50k-user headroom (realtime-06),
    but this is only reachable if the account's On-Demand Standard vCPU quota (L-1216C47A)
    allows it: max ≈ quota_vCPU / instance_vCPU. With the default 16-vCPU quota and
    c7i.xlarge (4 vCPU), the real ceiling is 4 — keep max_instances truthful to the quota
    until an increase lands (realtime-16).
  EOT
  type        = number
  default     = 50
}

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "EC2 instance type (CPU-optimized recommended for MediaSoup)"
  type        = string
  default     = "c7i.xlarge"
}

variable "instance_architecture" {
  description = <<-EOT
    CPU architecture for the AMI + container image: "amd64" (x86_64, default) or "arm64" (Graviton).
    Must match instance_type: c7i/c7g => amd64, c8g => arm64. Default keeps today's amd64 AMI.
    Flip to arm64 only after a multi-arch MSAB image is published + staging-validated (realtime-06 HITL).
  EOT
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["amd64", "arm64"], var.instance_architecture)
    error_message = "instance_architecture must be \"amd64\" or \"arm64\"."
  }
}

variable "ssh_public_key_path" {
  description = "Path to SSH public key for EC2 access"
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.r7g.large"
}

variable "redis_auth_token" {
  description = "AUTH token for ElastiCache Redis (16-128 chars, no @, /, or quotes)"
  type        = string
  sensitive   = true
}

variable "app_port" {
  description = "Application HTTP/WebSocket port"
  type        = number
  default     = 3030
}

variable "rtc_min_port" {
  description = "Minimum WebRTC UDP port"
  type        = number
  default     = 10000
}

variable "rtc_max_port" {
  description = "Maximum WebRTC UDP port"
  type        = number
  default     = 59999
}

variable "audio_domain" {
  description = "Domain for the audio server"
  type        = string
  default     = "audio.flyliveapp.com"
}

# Secrets — passed via environment variables (TF_VAR_*) or terraform.tfvars
variable "laravel_internal_key" {
  description = "Shared secret key for Laravel API authentication"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT secret shared with Laravel backend"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Express session secret"
  type        = string
  sensitive   = true
  default     = ""
}

# Cloudflare Realtime TURN (for WebRTC relay)
variable "cloudflare_turn_api_key" {
  description = "Cloudflare Realtime TURN API bearer token — server fetches short-lived credentials dynamically"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_turn_key_id" {
  description = "Cloudflare Realtime TURN key ID (the short hex in the API URL)"
  type        = string
  default     = ""
}

# --- realtime-08 broadcast flip thresholds ---
# Default 1500/1000. Lower (e.g. 2/1) in prod.tfvars to force a flip for a smoke
# test on a region without 1,500 real Listeners, then restore.
variable "room_broadcast_threshold_up" {
  description = "Listener count at/above which a Room flips to broadcast mode"
  type        = number
  default     = 1500
}

variable "room_broadcast_threshold_down" {
  description = "Listener count at/below which a Room flips back to interactive mode"
  type        = number
  default     = 1000
}

# --- realtime-09 broadcast HLS tier ---
# Disabled by default. When true, set all four HLS_R2_* + base URL (the MSAB config
# refine fails boot otherwise). R2 keys are stored as SSM secrets; the rest go into
# the container .env. See docs/issues/realtime/realtime-09-PROVISIONING.md.
variable "broadcast_hls_enabled" {
  description = "Enable the LL-HLS broadcast publish tier (realtime-09)"
  type        = bool
  default     = false
}

variable "hls_r2_endpoint" {
  description = "R2 S3 API endpoint, e.g. https://<acct>.r2.cloudflarestorage.com"
  type        = string
  default     = ""
}

variable "hls_r2_bucket" {
  description = "R2 bucket for live HLS artifacts (e.g. flylive-live-hls)"
  type        = string
  default     = ""
}

variable "hls_public_base_url" {
  description = "Public CDN base for HLS playback (no trailing slash), e.g. https://live.flyliveapp.com"
  type        = string
  default     = ""
}

variable "hls_r2_access_key_id" {
  description = "R2 Object Read/Write access key id for HLS publishing"
  type        = string
  sensitive   = true
  default     = ""
}

variable "hls_r2_secret_access_key" {
  description = "R2 Object Read/Write secret access key for HLS publishing"
  type        = string
  sensitive   = true
  default     = ""
}

# --- MSAB Application Config ---
# These are non-sensitive app config that gets written to the boot .env file

variable "jwt_max_age_seconds" {
  description = "Maximum JWT age in seconds — must match Laravel's MSAB JWT expiry (services.msab.jwt_expiry_hours)"
  type        = number
  default     = 2592000 # 30 days (720 hours × 3600)
}

variable "laravel_api_timeout_ms" {
  description = "Timeout for MSAB → Laravel API calls in milliseconds"
  type        = number
  default     = 10000 # 10 seconds
}

variable "ice_stun_urls" {
  description = "Comma-separated STUN server URLs for WebRTC NAT traversal"
  type        = string
  default     = "stun:stun.cloudflare.com:3478,stun:stun.cloudflare.com:53"
}
