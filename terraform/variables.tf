# =============================================================================
# FlyLive Audio Server — Terraform Variables
# =============================================================================

variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
  default     = "flylive-audio"
}

variable "github_deploy_environment" {
  description = "GitHub deployment environment (repo Settings → Environments) whose approved jobs may assume the OIDC deploy role — set per tfvars so staging and production runs can only assume their own role (ticket 12)"
  type        = string
  default     = "aws-production"
}

variable "environment" {
  # ⚠️ This description used to read "Resource names are isolated by AWS account,
  # not this value." That was a leftover from a two-account design and became
  # FALSE with ADR 0028, which puts both environments in ONE account keyed by
  # state file. Ticket 31 (decision D3) inverted it: names are qualified BY this
  # value, and each module derives `local.env_prefix` from it.
  description = "Deployment environment. Resource names are qualified BY this value — every module builds local.env_prefix = \"$${var.project_name}-$${var.environment}\" so staging and production can coexist in the single AWS account of ADR 0028. Two deliberate exceptions are account-global-shared and stay env-neutral (decision D2): the ECR repository + its lifecycle policy, and the GitHub OIDC identity provider. Also sets the Environment tag for cost allocation."
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

variable "image_tag" {
  description = "Pinned image tag (sha-<commit8> from the CI run that built it). Never \"latest\" — a cold-restore or instance replacement must always launch the exact staged/verified image."
  type        = string

  validation {
    condition     = var.image_tag != "" && var.image_tag != "latest"
    error_message = "image_tag must be a pinned sha-<commit8> tag, not empty or \"latest\"."
  }
}

variable "fleet_size" {
  description = <<-EOT
    MSAB instances per enabled region. ONE number on purpose — it drives the ASG's
    min_size, max_size AND desired_capacity, so the fleet is structurally fixed-size
    (ticket 18 AC #2; the fixed-size decision is ticket 06). It replaces the old
    min_instances / desired_instances / max_instances trio, which could silently drift
    into an elastic fleet by editing one of the three.

    🔴 Quota truth, OBSERVED 2026-08-12 in account 505307260926 / ap-south-1 — this block
    previously said 16 vCPU and "ticket 02's increase is FILED". BOTH WERE WRONG:

      L-1216C47A applied value = 5   (AWS default = 5, utilization 0)
      Quota request history    = "No requests found"

    fleet_size × instance vCPU must fit that quota. At c7i.xlarge (4 vCPU) the real ceiling
    is ONE instance — so this variable's own default of 2 (8 vCPU) does NOT currently fit,
    and an apply will fail at launch with VcpuLimitExceeded rather than at plan.

    The 2026-08-10 filing was almost certainly made against the OLD account 200810847703,
    which was closed the same day ticket 01 stood up this one; it did not carry over.
    Operator decision 2026-08-12: generate real usage FIRST (AWS is reluctant to grant
    increases to an unused account), then file. Set fleet_size = 1 until granted.

    The final number comes from ticket 35's saturation curve; keep this comment truthful to
    the quota actually in force, and re-read the console rather than trusting this text.
  EOT
  type        = number
  default     = 2
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
  description = "ElastiCache node type for the CACHE store (evict-freely; rate limits, presence, socket.io pub/sub)"
  type        = string
  default     = "cache.r7g.large"
}

variable "redis_durable_node_type" {
  description = "ElastiCache node type for the DURABLE store (noeviction + snapshots; money queue, room/seat/block state). Its node size IS its memory ceiling. null = same as redis_node_type."
  type        = string
  default     = null
}

variable "redis_durable_snapshot_retention_days" {
  description = "Automated snapshot retention (days) for the durable store. Must be > 0 (aws-platform-build/21)."
  type        = number
  default     = 7

  validation {
    condition     = var.redis_durable_snapshot_retention_days > 0
    error_message = "The durable store must keep snapshots (aws-platform-build/21): retention must be > 0 — its snapshots are the only backup of the in-flight money queue."
  }
}

variable "redis_durable_snapshot_window" {
  description = "Daily UTC snapshot window for the durable store (21:00-22:00 UTC ≈ 02:00-03:00 PKT off-peak)"
  type        = string
  default     = "21:00-22:00"
}

# --- Sizing/HA profile per store (aws-production/01) ---
# ⛔ Production must never set these: the defaults ARE the pre-ticket literals,
# which is what keeps `plan -var-file=prod.tfvars` diff-free. Staging turns them
# down in staging.tfvars (~$650/mo → ~$40/mo). Bad combinations (failover on a
# single node, multi-AZ without failover) fail at PLAN via preconditions in
# modules/redis/main.tf.

variable "redis_num_cache_clusters" {
  description = "Nodes in the CACHE replication group. 2 = primary + replica in another AZ (production); 1 = single node, no HA (staging)."
  type        = number
  default     = 2
}

variable "redis_automatic_failover" {
  description = "Automatic failover on the CACHE store. Requires redis_num_cache_clusters >= 2."
  type        = bool
  default     = true

  validation {
    condition     = !var.redis_automatic_failover || var.redis_num_cache_clusters >= 2
    error_message = "redis_automatic_failover requires redis_num_cache_clusters >= 2 — a single-node replication group has nothing to fail over to."
  }
}

variable "redis_multi_az" {
  description = "Multi-AZ on the CACHE store. Requires redis_automatic_failover."
  type        = bool
  default     = true

  validation {
    condition     = !var.redis_multi_az || var.redis_automatic_failover
    error_message = "redis_multi_az requires redis_automatic_failover — AWS rejects multi-AZ without failover."
  }
}

variable "redis_durable_num_cache_clusters" {
  description = "Nodes in the DURABLE replication group. null = same as the cache store."
  type        = number
  default     = null
}

variable "redis_durable_automatic_failover" {
  description = "Automatic failover on the DURABLE store. null = same as the cache store."
  type        = bool
  default     = null

  validation {
    condition = !coalesce(var.redis_durable_automatic_failover, var.redis_automatic_failover, false) || (
      var.redis_durable_num_cache_clusters != null ? var.redis_durable_num_cache_clusters : var.redis_num_cache_clusters
    ) >= 2
    error_message = "The durable store's automatic failover requires >= 2 nodes (redis_durable_num_cache_clusters, or redis_num_cache_clusters when it is null)."
  }
}

variable "redis_durable_multi_az" {
  description = "Multi-AZ on the DURABLE store. null = same as the cache store."
  type        = bool
  default     = null

  validation {
    condition = !coalesce(var.redis_durable_multi_az, var.redis_multi_az, false) || coalesce(
      var.redis_durable_automatic_failover, var.redis_automatic_failover, false
    )
    error_message = "The durable store's multi-AZ requires its automatic failover — AWS rejects multi-AZ without failover."
  }
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
  description = <<-EOT
    Last WebRTC port (ticket 11). The app binds ONE shared UDP+TCP port per
    mediasoup worker (WebRtcServer: rtc_min_port + worker index) — not one per
    user — so 64 ports covers a 32-vCPU instance with headroom. Was 59999
    (50,000 ports) on Vultr; that width was never used. The app crashes loudly
    if the shared-port mode fails, so the firewalled per-transport fallback can
    never engage silently (worker.manager.ts).
  EOT
  type        = number
  default     = 10063
}

variable "enabled_regions" {
  description = <<-EOT
    Regions that actually render resources (ticket 11, operator decision
    2026-08-10): Mumbai-only at launch; Frankfurt/Singapore stay defined in
    code but OFF until deliberately enabled. Must include "mumbai" — it hosts
    the global resources' home region (state, ECR, SNS).
  EOT
  type        = set(string)
  default     = ["mumbai"]

  validation {
    condition     = alltrue([for r in var.enabled_regions : contains(["mumbai", "frankfurt", "singapore"], r)]) && contains(var.enabled_regions, "mumbai")
    error_message = "enabled_regions must be a subset of {mumbai, frankfurt, singapore} and must include mumbai."
  }
}

variable "cascade_enabled" {
  description = "Enable the SFU cascade relay in the MSAB app (CASCADE_ENABLED). Cascade pipes audio between instances when a room spans them — required until room affinity (affinity epic) is attested live."
  type        = bool
  default     = true
}

variable "cascade_ports_open" {
  description = "Open UDP 40000-49999 (cascade plainTransport range) to the internet. Must stay true while cascade_enabled=true: cascade uses instance PUBLIC IPs even between two instances in the same region. Close only when cascade is retired."
  type        = bool
  default     = true

  validation {
    condition     = var.cascade_ports_open || !var.cascade_enabled
    error_message = "cascade_enabled=true requires cascade_ports_open=true — cascade audio between instances (same region included) arrives on UDP 40000-49999 from public IPs; closing the ports while cascade is on silently breaks multi-instance rooms."
  }
}

variable "audio_domain" {
  description = "Domain for the audio server"
  type        = string
  default     = "audio.flyliveapp.com"
}

# --- Cloudflare (DNS zone hosting audio_domain — used for unattended ACM validation) ---
variable "cloudflare_api_token" {
  description = "Cloudflare API token (DNS Read + DNS Write on the audio_domain zone) — used to create ACM DNS validation records and read CAA records for the pre-issuance check"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the zone hosting audio_domain"
  type        = string
}

variable "caa_records_override" {
  description = <<-EOT
    TEST SEAM — substitutes the live Cloudflare CAA lookup in offline
    terraform tests (see modules/ssl/variables.tf for why: the provider's
    nested cloudflare_dns_records result schema cannot be mocked). null =
    query Cloudflare (the production path — default everywhere outside
    tests). Never set this outside tests.
  EOT
  type = list(object({
    tag   = string
    value = string
  }))
  default = null
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

# --- Alerting (ticket 32) ---
# Empty (default) ships alerting INERT: the global SNS topic (modules/alerting)
# is created, alarms are wired to it, but nobody is subscribed — so nothing
# can page anyone by accident until an operator deliberately sets this.
variable "alert_email" {
  description = "Email address to subscribe to the global alerts SNS topic. Empty = topic exists, no subscriber (ships inert). Setting it requires a manual confirmation click in that inbox before delivery starts (SNS behavior, not a bug)."
  type        = string
  default     = ""
}
