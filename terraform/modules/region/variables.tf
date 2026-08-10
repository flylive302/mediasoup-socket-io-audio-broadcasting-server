# Region composite module — variables
# One instance of this module = one complete MSAB region (networking, redis,
# ssl, loadbalancer, ssm, cloudwatch, autoscaling).

variable "region_name" {
  description = "Short region name used in tags/keys (mumbai | frankfurt | singapore)"
  type        = string
}

variable "aws_region" {
  description = "AWS region id this module's provider points at (e.g. ap-south-1)"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR for this region+environment — from the ticket-11 allocation table; one-way once applied"
  type        = string
}

variable "project_name" { type = string }
variable "environment" { type = string }
variable "app_port" { type = number }
variable "rtc_min_port" { type = number }
variable "rtc_max_port" { type = number }
variable "cascade_ports_open" { type = bool }
variable "cascade_enabled" { type = bool }

variable "redis_node_type" { type = string }

# --- Durable/cache store split (aws-platform-build/21) ---
variable "redis_durable_node_type" {
  description = "Node type for the DURABLE store (its own memory ceiling, distinct from the cache store's). null = same as redis_node_type."
  type        = string
  default     = null
}

variable "redis_durable_snapshot_retention_days" {
  description = "Automated snapshot retention for the durable store. Must be > 0 — its snapshots are the only backup of the in-flight money queue."
  type        = number
  default     = 7

  validation {
    condition     = var.redis_durable_snapshot_retention_days > 0
    error_message = "The durable store must keep snapshots (aws-platform-build/21 AC): retention must be > 0."
  }
}

variable "redis_durable_snapshot_window" {
  description = "Daily UTC snapshot window for the durable store (default 21:00-22:00 UTC ≈ 02:00-03:00 PKT, off-peak for the Pakistan-centric audience)."
  type        = string
  default     = "21:00-22:00"
}
variable "redis_auth_token" {
  type      = string
  sensitive = true
}

variable "audio_domain" { type = string }
variable "cloudflare_zone_id" { type = string }

variable "caa_records_override" {
  description = "TEST SEAM — see modules/ssl/variables.tf. null = query Cloudflare (production path). Never set outside tests."
  type = list(object({
    tag   = string
    value = string
  }))
  default = null
}
variable "instance_type" { type = string }
variable "instance_architecture" { type = string }
variable "ssh_public_key_path" { type = string }
variable "instance_profile_name" { type = string }

# Ticket 16: the shared EC2 IAM role name, forwarded to modules/ssm so it can
# attach a kms:Decrypt grant (scoped to this region's own CMK) to the same
# role instance_profile_name above belongs to. Not sourced inside modules/iam
# itself — that would require modules/iam to depend on this region's ssm
# output for the key ARN, which cycles back against this module's existing
# dependency on modules/iam for instance_profile_name.
variable "iam_role_name" { type = string }
variable "ecr_repo_url" { type = string }

variable "laravel_internal_key" {
  type      = string
  sensitive = true
}
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "session_secret" {
  type      = string
  sensitive = true
}
variable "cloudflare_turn_api_key" {
  type      = string
  sensitive = true
}
variable "cloudflare_turn_key_id" { type = string }

variable "cors_origins" { type = string }
variable "laravel_api_url" { type = string }
variable "jwt_max_age_seconds" { type = number }
variable "laravel_api_timeout_ms" { type = number }
variable "ice_stun_urls" { type = string }

variable "room_broadcast_threshold_up" { type = number }
variable "room_broadcast_threshold_down" { type = number }

variable "broadcast_hls_enabled" { type = bool }
variable "hls_r2_endpoint" { type = string }
variable "hls_r2_bucket" { type = string }
variable "hls_public_base_url" { type = string }
variable "hls_r2_access_key_id" {
  type      = string
  sensitive = true
}
variable "hls_r2_secret_access_key" {
  type      = string
  sensitive = true
}

variable "image_tag" {
  description = "Pinned image tag (sha-<commit8>) forwarded to the autoscaling module. Never \"latest\"."
  type        = string
}

# Fixed-size fleet — one number, wired to the ASG's min = max = desired (ticket 18).
variable "fleet_size" { type = number }
