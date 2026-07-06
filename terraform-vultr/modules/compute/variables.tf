variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "instance_plan" {
  type = string
}

variable "firewall_group_id" {
  type = string
}

variable "app_port" {
  type = number
}

variable "rtc_min_port" {
  type = number
}

variable "rtc_max_port" {
  type = number
}

# --- Image ---

variable "ghcr_image" {
  description = "ghcr.io repository path (without tag)."
  type        = string
  default     = "ghcr.io/flylive302/mediasoup-socket-io-audio-broadcasting-server"
}

variable "image_tag" {
  description = "Pinned image tag (sha-<commit8> from the CI run that built it). Never \"latest\" — a cold-restore or instance replacement must always launch the exact staged/verified image."
  type        = string

  validation {
    condition     = var.image_tag != "" && var.image_tag != "latest"
    error_message = "image_tag must be a pinned sha-<commit8> tag, not empty or \"latest\"."
  }
}

variable "ghcr_pull_token" {
  description = "Read-only classic GitHub PAT (read:packages only) for `docker login ghcr.io`."
  type        = string
  sensitive   = true
}

# --- App secrets / config (mirrors AWS user-data.sh's rendered env file) ---

variable "laravel_internal_key" {
  type      = string
  sensitive = true
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "jwt_max_age_seconds" {
  type    = number
  default = 86400
}

variable "session_secret" {
  type      = string
  sensitive = true
}

variable "laravel_api_url" {
  type = string
}

variable "laravel_api_timeout_ms" {
  type    = number
  default = 30000
}

variable "cors_origins" {
  type = string
}

variable "ice_stun_urls" {
  type    = string
  default = "stun:stun.cloudflare.com:3478,stun:stun.cloudflare.com:53"
}

variable "cloudflare_turn_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "cloudflare_turn_key_id" {
  type    = string
  default = ""
}

variable "cascade_enabled" {
  type    = bool
  default = true
}

variable "mediasoup_num_workers" {
  description = "MediaSoup workers = vCPU - 1 (reserve one core for the Node.js event loop). Default 1 matches instance_plan's default vhf-2c-4gb (2 vCPU)."
  type        = number
  default     = 1
}

# --- Broadcast HLS tier (realtime-09) ---

variable "broadcast_hls_enabled" {
  type    = bool
  default = false
}

variable "hls_r2_endpoint" {
  type    = string
  default = ""
}

variable "hls_r2_bucket" {
  type    = string
  default = ""
}

variable "hls_public_base_url" {
  type    = string
  default = ""
}

variable "hls_r2_access_key_id" {
  type      = string
  sensitive = true
  default   = ""
}

variable "hls_r2_secret_access_key" {
  type      = string
  sensitive = true
  default   = ""
}

# --- Valkey (from the valkey module's outputs) ---

variable "redis_host" {
  type = string
}

variable "redis_port" {
  type = string
}

variable "redis_password" {
  type      = string
  sensitive = true
}

variable "redis_ca_certificate" {
  description = "PEM CA certificate for the managed Valkey endpoint's TLS cert (Vultr's private CA — not in the OS trust store)."
  type        = string
  sensitive   = true
}
