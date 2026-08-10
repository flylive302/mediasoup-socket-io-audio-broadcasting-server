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

variable "instance_count" {
  description = "Number of instances in this region's fixed HA fleet (slice 05). Each gets its OWN reserved IP (announced IP) and a unique, deterministic INSTANCE_ID_OVERRIDE (`<project>-<region>-<n>`) so Redis CAS room-ownership never collides. Keep >= 2 in prod for HA."
  type        = number
  default     = 1

  validation {
    condition     = var.instance_count >= 1
    error_message = "instance_count must be >= 1."
  }
}

variable "firewall_group_id" {
  type = string
}

variable "vpc_ids" {
  description = "Legacy VPC (private network) IDs to attach the instance to, so the load balancer can reach it over the private network. Empty = no private network."
  type        = list(string)
  default     = []
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

# Rotation-overlap secrets — comma-separated OUTGOING values that verifiers keep
# accepting during a rotation. Empty outside one. See the root variables.tf for
# the full rationale.

variable "laravel_internal_key_previous" {
  type      = string
  sensitive = true
  default   = ""
}

variable "jwt_secret_previous" {
  type      = string
  sensitive = true
  default   = ""
}

variable "internal_api_key_previous" {
  type      = string
  sensitive = true
  default   = ""
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

# msab-sentry §5. Optional by design: an empty DSN disables error reporting
# (cloud-init warns, never aborts) so telemetry can never take audio down.
# sensitive so it is redacted from plan output. Sourced from the
# TF_VAR_sentry_dsn vultr-production environment secret.
variable "sentry_dsn" {
  type      = string
  sensitive = true
  default   = ""
}

variable "cascade_enabled" {
  # aws-app-affinity/12: default changed true → false to agree with the
  # application schema's own documented default (src/config/index.ts). Was
  # previously unreachable from the root (no var, no var-file, no environment
  # override could get here), so production ran on this default alone,
  # contradicting the app's documented `false`. The root now declares and
  # threads this var explicitly (see ../../variables.tf) so the deployed
  # value is a config decision, not an accident of a module default.
  type    = bool
  default = false
}

variable "affinity_enabled" {
  # aws-app-affinity/12: operator attestation that Room-affinity guarantees
  # (07/09/11) are live for this deployment. MSAB cannot verify this itself —
  # it only asserts the combination `cascade_enabled=false` +
  # `affinity_enabled=false` refuses to boot. See AFFINITY_ENABLED in
  # src/config/index.ts.
  type    = bool
  default = false
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
